// test/fixtures/mock-connection.mjs — Loader 组装测试用的 connection 替代品。
// 与真实宿主一致：重复 exact Fetch 路由抛错，register 返回摘除该路由的异步
// disposer；list() 供 runner 断言存活路由数。插件的面板路由经 connection.fetch
// 注册（而不是 webServer.register 的 exact 路由），因而受 /api 信任栅栏保护
// （红队①的修复：exact 路由会抢在栅栏之前命中）。
export const name = 'mock-connection'
export const inject = []

export function apply(ctx) {
  const routes = new Map()
  ctx.provide('connection', {
    fetch: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate Fetch route: ${route.path}`)
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
    list() { return [...routes.keys()] },
  })
}
