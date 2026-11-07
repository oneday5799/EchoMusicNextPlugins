// Resolve hook aliasing the host-only "echo:plugin-sdk" specifier to a local
// stub so Node tests can import the real plugin modules unchanged.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'echo:plugin-sdk') {
    return {
      url: new URL('./echo-plugin-sdk-stub.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
