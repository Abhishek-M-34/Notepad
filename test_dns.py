import socket

domains = ["google.com", "api.groq.com", "pypi.org"]

for domain in domains:
    try:
        addr = socket.gethostbyname(domain)
        print(f"Success: {domain} -> {addr}")
    except Exception as e:
        print(f"Failed: {domain} -> {e}")
