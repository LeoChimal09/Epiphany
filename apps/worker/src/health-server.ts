import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { checkConfigHealth, type Env } from "@epiphany/core";

export interface HealthServer {
  port: number;
  stop: () => Promise<void>;
}

export function startHealthServer(port: number, env: Env): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health") {
      const report = checkConfigHealth("worker", env);
      res.writeHead(report.status === "ok" ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(report));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        stop: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
