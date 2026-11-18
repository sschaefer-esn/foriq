const net = require("net");
const { LocalizedError } = require("../i18n");

function isFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

// Fixed ports: no fallback (sensors and tools know the address).
// In use → error; the service retries with backoff.
function requirePort(port, host) {
  return async () => {
    if (await isFree(port, host)) return port;
    throw new LocalizedError("err.portBusy", { port });
  };
}

module.exports = { isFree, requirePort };
