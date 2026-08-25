import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import '../web.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Trace — 把重复工作沉淀为 Skill' },
      { name: 'description', content: '静默理解你的真实操作，在重复工作值得沉淀时提醒你。' },
    ],
    links: [{ rel: 'icon', type: 'image/png', href: '/trace-spirit-icon.png' }],
  }),
  notFoundComponent: () => (
    <main className="not-found">
      <p>404</p>
      <h1>这里还没有留下工作流。</h1>
      <a href="/">返回首页</a>
    </main>
  ),
  component: RootComponent,
})

function RootComponent() {
  return (
    <html lang="zh-CN">
      <head><HeadContent /></head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
