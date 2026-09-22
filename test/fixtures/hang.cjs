// test/fixtures/hang.cjs — 挂住不退出（给「到点收口」用例用）。
// 什么也不做，只让事件循环一直活着；被杀才算结束。
setInterval(() => {}, 1000)
