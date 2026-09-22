@echo off
REM test/fixtures/hang.cmd - hangs until killed (for the default tree-kill test).
REM A .cmd goes through the shell, so the fixed `--profile headless "<task>"` arguments
REM are swallowed by this launcher instead of being read as Node options.
ping -n 60 127.0.0.1 > nul
