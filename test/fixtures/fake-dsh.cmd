@echo off
REM test/fixtures/fake-dsh.cmd - end-to-end launcher shell (Windows).
REM Real dsh.cmd has this shape: it takes `--profile headless "<task>"` as its own args,
REM then wakes the session process. Here the args are ignored and the woken script runs.
REM This file is CRLF on purpose (.gitattributes pins it): cmd.exe does not read LF batch
REM files, and an LF copy fails with a confusing "'.cmd' is not recognized" error.
REM The end-to-end test copies this file and its sibling script into one ASCII temp
REM directory, so %~dp0 resolves to the copy and the non-ASCII repo path never reaches cmd.exe.
node "%~dp0fake-dsh-script.cjs"
