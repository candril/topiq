import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://candril.github.io',
  base: '/topiq',
  integrations: [
    starlight({
      title: 'topiq',
      description: 'Peek, filter, replay. Kafka without leaving the terminal.',
      logo: {
        src: './src/assets/logo.svg',
      },
      favicon: '/logo.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/candril/topiq',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/candril/topiq/edit/main/site/',
      },
      sidebar: [
        {
          label: 'Guide',
          items: [
            { label: 'Installation', slug: 'guide/installation' },
            { label: 'Getting Started', slug: 'guide/getting-started' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Key Bindings', slug: 'reference/key-bindings' },
            { label: 'Peek & Filter', slug: 'reference/peek-and-filter' },
            { label: 'Replay & Produce', slug: 'reference/replay' },
            { label: 'Consumer Groups', slug: 'reference/groups' },
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'CLI', slug: 'reference/cli' },
          ],
        },
      ],
      customCss: ['./src/styles/custom.css'],
    }),
  ],
})
