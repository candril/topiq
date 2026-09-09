import { useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import type { ClusterSession, ConnectCluster } from "@/clusterSession.ts"
import { buildCommands } from "@/commands/builder.ts"
import { commandContext, keyboardOwned } from "@/commands/context.ts"
import { matchCommands } from "@/commands/match.ts"
import { NO_VIEW_COMMANDS, type ViewCommands } from "@/commands/registry.ts"
import { runPaletteCommand } from "@/commands/run.ts"
import type { Command } from "@/commands/types.ts"
import { isProd, type ClusterProfile } from "@/config/schema.ts"
import { copyDestinations } from "@/config/siblings.ts"
import { levelNav, listNav, normalizeKey } from "@/keys.ts"
import { appReducer, createInitialState } from "@/state.ts"
import type { AppState, StatusKind, StatusMessage } from "@/state.ts"
import { theme } from "@/theme.ts"
import { ClusterPicker } from "@/views/ClusterPicker.tsx"
import { CommandPalette } from "@/views/CommandPalette.tsx"
import { ConfirmWrite } from "@/views/ConfirmWrite.tsx"
import { GroupList } from "@/views/GroupList.tsx"
import { HelpPanel } from "@/views/HelpPanel.tsx"
import { Loading } from "@/views/Loading.tsx"
import { randomConnectMessage } from "@/views/loadingMessages.ts"
import { MessageTable } from "@/views/MessageTable.tsx"
import { TopicList } from "@/views/TopicList.tsx"

export interface AppProps {
  profiles: ClusterProfile[]
  /** Pre-connected when a cluster was named on the CLI; null boots into the picker. */
  /** Connected on mount, after the first paint (see index.tsx). */
  autoConnect: ClusterProfile | null
  initialTopic: string | null
  /** Builds client + registry for a picked profile — implemented in index.tsx (spec 003). */
  connect: ConnectCluster
  /** Startup diagnostic to surface once the TUI is up (e.g. config not loadable). */
  initialStatus?: StatusMessage
  onExit: () => void
}

const MODE_LABELS: Record<AppState["mode"], string> = {
  beginning: "beginning",
  // Only an offset-seek target today (spec 018) — the fetch prompt cannot ask for it, but
  // the mode and the range share one vocabulary and this keeps them exhaustive.
  end: "end",
  offset: "offset",
  latestN: "latest",
  timestamp: "timestamp",
}

// Long enough to read a result; errors are exempt (below) since nothing else shows them.
const STATUS_CLEAR_MS = 5000

// A wait longer than this is boring; a new line makes it read as alive (spec 025).
const LOADING_MESSAGE_MS = 5000

// Stable identity for the closed palette: rebuilding [] every render would churn nothing
// useful and the key handler closes over it.
const NO_COMMANDS: Command[] = []

export function App({
  profiles,
  autoConnect,
  initialTopic,
  connect,
  initialStatus,
  onExit,
}: AppProps) {
  const [state, dispatch] = useReducer(appReducer, undefined, () =>
    createInitialState({
      cluster: null,
      topic: initialTopic,
      status: initialStatus ?? null,
    }),
  )
  const [session, setSession] = useState<ClusterSession | null>(null)
  // Enter on the picker while password_cmd still runs must not start a second connect.
  // The ref guards synchronously; the state paints the loader (spec 025) — a state update
  // lands too late to stop the second Enter.
  const connecting = useRef(false)
  const [connectingTo, setConnectingTo] = useState<string | null>(null)
  // What the on-screen view contributes to the palette (spec 021): the row under its cursor
  // and the actions only it can perform. A ref, not state: registering must not re-render
  // the view that just registered, and the palette reads it when it opens.
  const viewCommands = useRef<ViewCommands>(NO_VIEW_COMMANDS)
  const registerCommands = useCallback((commands: ViewCommands) => {
    viewCommands.current = commands
  }, [])

  // `topic` is only passed by the boot path: SELECT_CLUSTER clears the topic (a stale one
  // would aim at another cluster's watermarks), so a `topiq <cluster> <topic>` argument has
  // to be re-applied on the far side of the connect.
  const selectCluster = (profile: ClusterProfile, topic?: string | null) => {
    if (connecting.current) {
      return
    }
    connecting.current = true
    setConnectingTo(profile.name)
    const previous = session
    dispatch({ type: "SHOW_STATUS", message: `connecting to ${profile.name}…` })
    connect(profile).then(
      (next) => {
        connecting.current = false
        setConnectingTo(null)
        setSession(next)
        dispatch({ type: "SELECT_CLUSTER", cluster: profile.name })
        if (topic) {
          dispatch({ type: "SELECT_TOPIC", topic })
        }
        dispatch({ type: "CLEAR_STATUS" })
        // The old session survives an ascend to the picker; only a new pick replaces it.
        void previous?.client.disconnect().catch(() => {})
      },
      (err: unknown) => {
        connecting.current = false
        setConnectingTo(null)
        const message = err instanceof Error ? err.message : String(err)
        dispatch({ type: "SHOW_STATUS", message: `${profile.name}: ${message}`, kind: "error" })
      },
    )
  }

  // Connect after the first frame, never before it: the picker paints instantly and the
  // status line carries the wait.
  useEffect(() => {
    if (autoConnect) {
      selectCluster(autoConnect, initialTopic)
    }
    // Mount only — selectCluster is recreated per render and re-running would reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Built only while the palette is open. It reads the live registration during render,
  // which is safe here for one reason: the view underneath is suspended while the palette
  // has the keyboard, so its focus cannot change out from under the list being shown.
  const matches =
    state.palette === null
      ? NO_COMMANDS
      : matchCommands(
          buildCommands(
            commandContext({
              state,
              profile: session?.profile ?? null,
              focus: viewCommands.current.focus,
              copyDestinations:
                session === null ? 0 : copyDestinations(profiles, session.profile).length,
            }),
          ),
          state.palette.query,
        )

  const runFromPalette = (command: Command): void => {
    // Closed first: a command that suspends the TUI for $EDITOR (spec 014/015) must not
    // leave the overlay painted over the view it returns to.
    dispatch({ type: "PALETTE_CLOSE" })
    runPaletteCommand(command, { dispatch, quit: onExit, view: viewCommands.current.actions })
  }

  useKeyboard((key) => {
    const k = normalizeKey(key)
    // Before every overlay: ^c is the one key that must never be swallowed, whatever is on
    // screen — nothing it can interrupt is a write in flight (the dialogs commit on a
    // shift-letter, spec 019).
    if (k.ctrl && k.name === "c") {
      onExit()
      return
    }
    if (state.palette !== null) {
      // The <input> owns the text and enter; only movement and dismissal are ours. `j`/`k`
      // are characters in a query, so the letter synonyms stand down (spec 020).
      const nav = listNav(k, { letters: false })
      if (nav) {
        return dispatch({
          type: "PALETTE_MOVE",
          delta: nav === "next" ? 1 : -1,
          rowCount: matches.length,
        })
      }
      if (k.name === "escape") {
        dispatch({ type: "PALETTE_CLOSE" })
      }
      return
    }
    // The overlay captures the keyboard while open: esc/?/q close, all else is swallowed.
    if (state.helpOpen) {
      if (k.name === "escape" || k.name === "?" || k.name === "q") {
        dispatch({ type: "CLOSE_HELP" })
      }
      return
    }
    // Spec 021's precedence rule: with a list, menu or text field open, `^p` is "previous"
    // and the palette stands down — the base views give the chord up instead (listNav's
    // `ctrlPrev`), so opening it never moves a cursor underneath at the same time.
    if (k.ctrl && k.name === "p" && !keyboardOwned(state)) {
      dispatch({ type: "PALETTE_OPEN" })
      return
    }
    // While the topic filter or a range prompt is capturing text, "q" and "?" are just
    // characters — and esc belongs to the capturing view, not to ascend.
    if (state.topics.filterActive && state.topic === null) {
      return
    }
    // The write dialog owns the keyboard outright: `q` must not quit out from under a
    // pending produce, and `?` must not stack help on top of it (spec 019).
    if (
      state.topic !== null &&
      (state.messages.prompt !== null ||
        state.messages.filter.active ||
        state.messages.jsEditor !== null ||
        state.messages.confirm !== null ||
        state.messages.copy !== null)
    ) {
      return
    }
    // The group view sits beside the topic list rather than under it, so it claims the
    // level keys itself: ascend leaves it, and nothing below it exists to descend into.
    if (state.groups.topic !== null) {
      // The seek bar and its confirm dialog own the keyboard outright: `q` must not quit
      // out from under a pending offset write, and `?` must not stack help on it (019).
      if (state.groups.filterActive || state.groups.seek !== null) {
        return
      }
      if (k.name === "q") {
        onExit()
        return
      }
      if (k.name === "?") {
        dispatch({ type: "OPEN_HELP" })
        return
      }
      const leaving =
        levelNav(k) === "ascend" ||
        (k.name === "escape" && state.groups.filter === "" && state.groups.pane === "none")
      if (leaving) {
        dispatch({ type: "GROUPS_CLOSE" })
      }
      return
    }
    if (k.name === "q") {
      onExit()
      return
    }
    if (k.name === "?") {
      dispatch({ type: "OPEN_HELP" })
      return
    }
    // `h`/← ascend the same level esc does, but unconditionally: a navigation key must not
    // double as "clear the filter" / "close the pane" (spec 020). Descend (`l`/→) stays
    // with the views — only they know what the cursor is on.
    //
    // The message table is excluded: it is a grid, so there h/l walk the column cursor
    // (spec 024). Esc is the way out of it, and it is unambiguous.
    if (levelNav(k) === "ascend" && state.topic === null) {
      if (state.cluster !== null) {
        dispatch({ type: "SELECT_CLUSTER", cluster: null })
      }
      return
    }
    // Esc ascends one level (spec 020): table → topic list → picker. View-local esc
    // meanings (clear filter, close a pane) win first — both handlers see the same
    // state snapshot, so when a view claims esc the conditions below are still false.
    if (k.name === "escape") {
      if (state.topic !== null) {
        if (state.messages.filter.query === "" && state.messages.scan === null) {
          dispatch({ type: "SELECT_TOPIC", topic: null })
        }
        return
      }
      if (state.cluster !== null && state.topics.filter === "" && !state.topics.detailOpen) {
        dispatch({ type: "SELECT_CLUSTER", cluster: null })
      }
    }
  })

  // Flavour for the connect loader, replaced while the wait runs (spec 025). The status
  // line below carries the fact — which cluster — so this one only has to entertain.
  const [connectMessage, setConnectMessage] = useState(randomConnectMessage)
  useEffect(() => {
    if (connectingTo === null) {
      return
    }
    setConnectMessage(randomConnectMessage())
    const timer = setInterval(() => setConnectMessage(randomConnectMessage()), LOADING_MESSAGE_MS)
    return () => clearInterval(timer)
  }, [connectingTo])

  // Results clear themselves; errors stay until replaced — the line is the only place
  // an async failure is visible (nfr/004).
  useEffect(() => {
    if (!state.status || state.status.kind === "error") {
      return
    }
    const timer = setTimeout(() => dispatch({ type: "CLEAR_STATUS" }), STATUS_CLEAR_MS)
    return () => clearTimeout(timer)
  }, [state.status])

  // Help and the palette both take the keyboard outright; the view below stands down.
  const overlayOpen = state.helpOpen || state.palette !== null
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
      <Header state={state} profile={state.cluster !== null ? (session?.profile ?? null) : null} />
      {connectingTo !== null ? (
        <Loading message={connectMessage} />
      ) : state.cluster === null || session === null ? (
        <ClusterPicker
          profiles={profiles}
          ui={state.picker}
          suspended={overlayOpen}
          dispatch={dispatch}
          onSelect={selectCluster}
        />
      ) : state.groups.topic !== null ? (
        <GroupList
          client={session.client}
          topic={state.groups.topic}
          profile={session.profile}
          ui={state.groups}
          suspended={overlayOpen}
          registerCommands={registerCommands}
          dispatch={dispatch}
        />
      ) : state.topic === null ? (
        <TopicList
          client={session.client}
          profile={session.profile}
          ui={state.topics}
          suspended={overlayOpen}
          registerCommands={registerCommands}
          dispatch={dispatch}
        />
      ) : (
        <MessageTable
          client={session.client}
          registry={session.registry}
          topic={state.topic}
          profile={session.profile}
          profiles={profiles}
          connect={connect}
          ui={state.messages}
          suspended={overlayOpen}
          registerCommands={registerCommands}
          dispatch={dispatch}
        />
      )}
      {state.status && <StatusLine status={state.status} />}
      {state.palette !== null && (
        <CommandPalette
          ui={state.palette}
          matches={matches}
          dispatch={dispatch}
          onRun={runFromPalette}
        />
      )}
      {state.messages.confirm && (
        <ConfirmWrite
          prompt={state.messages.confirm.prompt}
          typed={state.messages.confirmTyped}
          onTyped={(typed) => dispatch({ type: "MSGS_CONFIRM_TYPED", typed })}
        />
      )}
      {state.groups.seek?.pending && (
        <ConfirmWrite
          prompt={state.groups.seek.pending.prompt}
          typed={state.groups.seekTyped}
          onTyped={(typed) => dispatch({ type: "GROUPS_CONFIRM_TYPED", typed })}
        />
      )}
      {state.helpOpen && <HelpPanel />}
    </box>
  )
}

function Header({ state, profile }: { state: AppState; profile: ClusterProfile | null }) {
  // Spec 023: the env shows everywhere the cluster does, prod in the warning colour —
  // driven by the declared env/prod flag only, never hostnames.
  const envLabel = profile ? (profile.env ?? (isProd(profile) ? "prod" : null)) : null
  const topic = state.topic ?? state.groups.topic
  return (
    <box flexDirection="row" width="100%" backgroundColor={theme.headerBg} paddingX={1} gap={2}>
      <text fg={theme.primary}>
        <strong>topiq</strong>
      </text>
      <text fg={state.cluster ? theme.text : theme.textDim}>{state.cluster ?? "no cluster"}</text>
      {envLabel && profile && (
        <text fg={isProd(profile) ? theme.warning : theme.textDim}>{envLabel}</text>
      )}
      {/* Always on, never transient: a reader of a screenshot, or a user who forgot which
          mode they started in, must not mistake this for a real cluster (spec 027). */}
      {profile?.demo && <text fg={theme.secondary}>demo · nothing here is real</text>}
      {/* The group view describes a topic without opening it, so the topic slot names the
          topic being described either way (spec 017). */}
      <text fg={topic ? theme.text : theme.textDim}>{topic ?? "no topic"}</text>
      <box flexGrow={1} />
      <text fg={theme.secondary}>
        {state.groups.topic !== null ? "groups" : MODE_LABELS[state.mode]}
      </text>
    </box>
  )
}

const STATUS_FG: Record<StatusKind, string> = {
  info: theme.text,
  success: theme.success,
  error: theme.error,
}

function StatusLine({ status }: { status: StatusMessage }) {
  return (
    <box width="100%" backgroundColor={theme.headerBg} paddingX={1}>
      <text fg={STATUS_FG[status.kind]}>{status.message}</text>
    </box>
  )
}
