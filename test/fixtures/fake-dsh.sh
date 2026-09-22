#!/bin/sh
# test/fixtures/fake-dsh.sh — 端到端用例的假启动器（POSIX 壳）。
# 与 fake-dsh.cmd 同形：吞掉 `--profile headless "<任务>"`，再跑被唤醒的那个脚本。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/fake-dsh-script.cjs"
