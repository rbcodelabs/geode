/** Node/cloud-only entry point. The existing portable wiki graph is unchanged. */
import {mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {publish,restore,type PublishRequest,type PublishResult,type RestoreResult} from "../wiki/catalog-contract";
import {materializeRestoredVault} from "../wiki/catalog-materialize";
import type {RestoreFolderResult} from "./index";
import {createNodeDsqlCatalog,type NodeDsqlOptions} from "./node-dsql-catalog";

export {createNodeDsqlCatalog} from "./node-dsql-catalog";
export {createPrivateBlobStore} from "./private-blob-store";
export type {NodeDsqlOptions,NodeDsqlConnection,NodeDsqlPool,NodeDsqlMetrics} from "./node-dsql-catalog";
export type {PrivateBlobOptions,BlobMetrics} from "./private-blob-store";
export type {PublishRequest,PublishResult,RestoreResult,CatalogLimits,RestoreLimits} from "../wiki/catalog-contract";

/** One policy-bound handle; callers cannot bypass validation or invoke DDL. */
export function createCloudCatalog(options: NodeDsqlOptions) {
  const catalog=createNodeDsqlCatalog(options);
  const limits={...options.limits,allowedContentTypes:[...options.limits.allowedContentTypes]};
  const source=catalog.restoreSource();
  return {
    publish:(request:PublishRequest):Promise<PublishResult>=>publish(catalog.store,request,{limits}),
    restore:(vaultId:string):Promise<RestoreResult>=>restore(source,vaultId),
    async restoreFolder({into,vaultId}:{into:string;vaultId:string}):Promise<RestoreFolderResult> {
      const restored=await restore(source,vaultId);
      if(restored.status!=="ok") return restored;
      try { await mkdir(into,{recursive:true}); }
      catch { return {status:"write-failed",root:resolve(into)}; }
      const written=await materializeRestoredVault(into,restored.vault);
      if(written.status!=="ok")return {status:written.status,root:written.root,path:written.path};
      return {status:"ok",root:written.root,vaultId,sequence:restored.vault.sequence,noteCount:written.noteCount,assetCount:written.assetCount,totalBytes:restored.vault.totalBytes};
    },
    metrics:catalog.metrics,
    close:catalog.close,
  };
}
