# 自维护上游：允许直接修改 9router/ 源码

ADR 0002 的"上游零改动"条款被取代：自本 ADR 起，`9router/` 是自维护的上游 checkout，可以直接修改其源码（首例：组合模型的思考强度上限与降级功能）。升级 = 切 submodule 到新 tag 后合并本地改动。驱动因素：功能（请求体重写、combo 路由）必须落在上游核心管线内，壳层无插件/钩子可挂，且 iRouter 自用定位等不起上游发版。

考虑过的替代方案：① 本地补丁机制（`desktop/patches/`，构建时应用）——升级冲突成本与直接改源码相同，但多一层维护面，弃用；② 对构建产物做热改——next standalone 是 minified bundle，不可行；③ 等待上游合入——可用性推迟且不可控。

**注意：本节约定修复冲突的责任在升级方（iRouter）。** CONTEXT.md 的"锁版上游"词条已同步更新。

Status: accepted (supersedes ADR 0002)