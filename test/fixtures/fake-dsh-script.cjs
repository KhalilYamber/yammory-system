// test/fixtures/fake-dsh-script.cjs — 端到端用例里「被启动器唤醒的那个会话进程」。
// 真 dsh.cmd 会把 `--profile headless "<任务>"` 当自己的参数（不往 node 传），然后按脚本名唤醒
// 真正的会话代码。这里就照这个形状：启动器壳（fake-dsh.cmd / .sh）把参数吞掉，再跑这个文件。
// 它只写一行、按环境变量给的码退出，用来验「真进程 ＋ 真命令行 ＋ 真退出码」这条链。

process.stdout.write(`${process.env.YAMMORY_FAKE_LINE ?? 'dsh-stub-ok'}\n`)
process.exit(Number(process.env.YAMMORY_FAKE_EXIT ?? '0'))
