import http from "node:http";

const tasks = [];
const port = Number(process.env.PORT || 19999);

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url === "/api/v1/info") {
    json(res, 200, {
      code: 0,
      msg: "",
      data: { version: "mock", os: "test", arch: "test" },
    });
    return;
  }
  if (req.url === "/api/v1/tasks" && req.method === "POST") {
    const payload = JSON.parse(body || "{}");
    tasks.push(payload);
    console.log("TASK", JSON.stringify(payload));
    json(res, 200, { code: 0, msg: "", data: "mock-task-" + tasks.length });
    return;
  }
  if (req.url === "/api/v1/tasks" && req.method === "GET") {
    json(res, 200, { code: 0, msg: "", data: tasks });
    return;
  }
  json(res, 404, { code: 1, msg: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log("mock gopeed listening on " + port);
});
