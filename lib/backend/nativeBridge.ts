import { browser } from "#imports";
import { parseComponent } from "./nativeClient";
import { nativeTransport, NativeTransportError } from "./nativeTransport";
import { NATIVE_MESSAGE, NATIVE_UNINSTALL, isRecord, trustedNativePage, validPageRequest, type ComponentOperation, type NativeReply } from "./nativeProtocol";

/** Operations after which the engine that answers is not the one that answered before, or
 *  none is: work in flight and the health read before them are stale. Reading state, pausing
 *  a download (which had already stopped the engine) and the idle timeout leave it alone. */
const REPLACES_ENGINE: Record<ComponentOperation, boolean> = {
  "status": false, "runtime": false, "models.pause": false, "engine.settings": false,
  "runtime.benchmark": true, // unloads it to compare configurations, then loads one again
  "runtime.config": true, "runtime.cancel": true, // loads another configuration, or restores one
  "models.download": true, // stops it while files are fetched, then starts it again
  "models.delete": true, "engine.stop": true, "engine.resume": true,
  "component.update": true, "component.uninstall": true,
};

let uninstallReceipt: string | null = null;
const error = (code: string, message: string, status = 400): NativeReply => ({v:1,id:"bridge",ok:false,status,error:{code,message}});

export async function handleNativePageMessage(
  message: unknown,
  sender: {id?:string;url?:string;frameId?:number},
  controls: {invalidate():void; clear():Promise<void>},
): Promise<NativeReply | {ok:boolean;error?:string} | undefined> {
  if (!isRecord(message) || (message.action !== NATIVE_MESSAGE && message.action !== NATIVE_UNINSTALL)) return undefined;
  if (!trustedNativePage(sender, browser.runtime.id, browser.runtime.getURL("/"))) return error("forbidden", "Only Anagram setup and settings can manage the local component",403);
  if (message.action === NATIVE_UNINSTALL) {
    if (!uninstallReceipt || message.receipt !== uninstallReceipt) return {ok:false,error:"Local cleanup has not completed"};
    uninstallReceipt = null;
    try {
      await controls.clear();
      await browser.storage.local.clear();
      nativeTransport().close();
      await browser.management.uninstallSelf({showConfirmDialog:false});
      return {ok:true};
    } catch { return {ok:false,error:"Remove the extension from the browser's extension page"}; }
  }
  if (!validPageRequest(message.op, message.payload)) return error("invalid_request","Invalid local operation");
  try {
    const reply = await nativeTransport().request(message.op,message.payload as Record<string,unknown>);
    if (reply.ok && REPLACES_ENGINE[message.op]) controls.invalidate();
    if (reply.ok) {
      const snapshot = parseComponent(reply.data);
      if (snapshot?.operation?.status === "completed") {
        if (snapshot.operation.name === "uninstall") uninstallReceipt = snapshot.operation.receipt;
        if (snapshot.operation.name === "update") {
          controls.invalidate();
          nativeTransport().close();
        }
      }
    }
    return reply;
  } catch (e) { return error(e instanceof NativeTransportError ? e.code : "native_unavailable", "Local component is not connected",503); }
}
