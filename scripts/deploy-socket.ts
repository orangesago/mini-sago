import { createConnection } from "node:net";

const MAX_RESPONSE_BYTES = 1_024;
const RESPONSE_TIMEOUT_MS = 10_000;

export async function requestMinisagoDeployment(
  socketPath: string,
  commit: string,
  channelId: string,
) {
  if (!socketPath.startsWith("/")) {
    throw new Error("MINISAGO_DEPLOY_SOCKET must be an absolute path.");
  }
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("MiniSago deployment requires a full commit SHA.");
  }
  if (!/^\d{17,20}$/u.test(channelId)) {
    throw new Error("MiniSago deployment requires a Discord channel ID.");
  }

  return await new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    const timeout = setTimeout(() => {
      socket.destroy(new Error("MiniSago deployment socket timed out."));
    }, RESPONSE_TIMEOUT_MS);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      const result = response.trim();
      if (result === `accepted ${commit}`) {
        resolve(result);
      } else {
        reject(
          new Error(result || "MiniSago deployment socket closed silently."),
        );
      }
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`deploy ${commit} ${channelId}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
        socket.destroy(
          new Error("MiniSago deployment socket returned too much data."),
        );
        return;
      }
      // systemd can hold the connection open until deployment finishes.
      if (response.includes("\n")) finish();
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("close", finish);
  });
}
