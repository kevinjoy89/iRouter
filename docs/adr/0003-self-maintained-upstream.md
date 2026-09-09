# 定制基线 v0.5.69：源码并入仓库根目录，可直接修改

ADR 0002 的"上游零改动"条款被取代：9Router 源码基于上游 decolua/9router **v0.5.69** 定制，已并入本仓库根目录（`src/`、`open-sse/`、`tests/` 等，原 `9router/` submodule 结构废弃），可直接修改（首例：组合模型的思考强度上限与降级、限流自动重试）。升级 = 对比上游新版本，手工合并本地定制。驱动因素：功能（请求体重写、combo 路由）必须落在路由核心管线内，壳层无插件/钩子可挂，且 iRouter 自用定位等不起上游发版。

考虑过的替代方案：① 本地补丁机制（`desktop/patches/`，构建时应用）——升级冲突成本与直接改源码相同，但多一层维护面，弃用；② 对构建产物做热改——next standalone 是 minified bundle，不可行；③ 等待上游合入——可用性推迟且不可控。

**注意：合并上游改动的责任在升级方（iRouter）。**

Status: accepted (supersedes ADR 0002)