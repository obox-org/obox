# 真实 Python 对端：按 Content-Length 分帧的极简 JSON-RPC 服务（供 python-real 测试用）。
#
# 行为：
# - 响应宿主请求 sum -> 返回 a+b
# - 响应宿主请求 pyVersion -> 返回解释器版本
# - 启动后主动发一条 ready 通知，并向宿主发一个 hostTime 请求（验证"对端也能调宿主"）
# - 收到宿主对 hostTime 的回包后，再发 gotReply 通知（端到端证据链）
import json
import sys


def send(message):
    payload = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(payload) + payload)
    sys.stdout.buffer.flush()


def main():
    buffer = b""
    send({"jsonrpc": "2.0", "method": "ready", "params": {"version": sys.version.split()[0]}})
    send({"jsonrpc": "2.0", "id": "child-1", "method": "hostTime"})
    while True:
        chunk = sys.stdin.buffer.read1(4096)
        if not chunk:
            return 0
        buffer += chunk
        while True:
            index = buffer.find(b"\r\n\r\n")
            if index < 0:
                break
            header = buffer[:index].decode("ascii", "replace").lower()
            length = 0
            for line in header.split("\r\n"):
                if line.startswith("content-length:"):
                    length = int(line.split(":", 1)[1].strip())
            body_start = index + 4
            if len(buffer) < body_start + length:
                break
            body = buffer[body_start : body_start + length]
            buffer = buffer[body_start + length :]
            message = json.loads(body.decode("utf-8"))
            method = message.get("method")
            if method == "sum":
                params = message.get("params") or {}
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "result": params.get("a", 0) + params.get("b", 0),
                    }
                )
            elif method == "pyVersion":
                send({"jsonrpc": "2.0", "id": message["id"], "result": sys.version.split()[0]})
            elif method is None and "id" in message:
                # 宿主对 hostTime 的回包
                send(
                    {
                        "jsonrpc": "2.0",
                        "method": "gotReply",
                        "params": {"result": message.get("result")},
                    }
                )


if __name__ == "__main__":
    sys.exit(main())
