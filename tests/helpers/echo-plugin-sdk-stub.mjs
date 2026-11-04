// Minimal echo:plugin-sdk runtime for Node tests, mirroring
// modules/EchoMusic/PluginSdk/sdk.mjs: state 2 resolves, anything else
// rejects with the operation's error message.
export async function awaitOperation(operation) {
  if (!operation) throw new Error('Unavailable operation');
  if (operation.state < 2) {
    await new Promise((resolve) => {
      const done = () => {
        operation.completed.disconnect(done);
        resolve();
      };
      operation.completed.connect(done);
    });
  }
  if (operation.state === 2) return operation.result;
  const error = new Error(operation.errorMessage);
  error.code = operation.errorCode;
  throw error;
}
