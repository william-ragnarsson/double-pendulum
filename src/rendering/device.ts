let devicePromise: Promise<GPUDevice | null> | null = null;

// Video export keeps a whole frame in one state buffer (32 B/px, ~150 MB at
// 2160²), above WebGPU's 128 MiB default binding limit, so ask for whatever
// the adapter allows up to 1 GiB.
const WANTED_BUFFER_BYTES = 1 << 30;

export async function getGPUDevice(): Promise<GPUDevice | null> {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, WANTED_BUFFER_BYTES),
        maxBufferSize:               Math.min(adapter.limits.maxBufferSize, WANTED_BUFFER_BYTES),
      },
    });
  })();
  return devicePromise;
}
