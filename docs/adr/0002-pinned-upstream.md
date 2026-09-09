# 9Router 上游锁版为 submodule，壳层零改动隔离

9router/ 以 git submodule 锁定 tag v0.5.69，任何情况下不改其源码；iRouter 的全部定制（窗口、托盘、打包）在独立壳层 desktop/ 中，通过进程边界与上游交互。升级 = 切 submodule 到新 tag 并重新构建。不 fork、不 patch，保证可复现与可升级；代价是面板内容保持上游原样（iRouter 品牌只体现在壳层）。

Status: accepted