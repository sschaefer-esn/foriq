"""Entry point of the bundled backend (PyInstaller, see build-backend.sh).

Equivalent to `uvicorn main:app --host H --port P --workers 1 --no-proxy-headers` in
webapp/backend, just without a separate Python. The supervisor starts it with the
same environment variables.

Subcommands for the app's USB helper (no separate Python needed in the bundle):
    foriq-backend flasher …   → firmware-cpp/tools/app_flasher.py
    foriq-backend esptool …   → esptool (used by app_flasher as a child process)
"""
import argparse
import sys


def run():
    if len(sys.argv) > 1 and sys.argv[1] == "flasher":
        import app_flasher
        sys.exit(app_flasher.main(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == "esptool":
        import esptool
        sys.argv = ["esptool", *sys.argv[2:]]
        sys.exit(esptool._main())

    import uvicorn

    import main  # webapp/backend/main.py (included via --paths)

    ap = argparse.ArgumentParser(prog="foriq-backend")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8420)
    args = ap.parse_args()
    # No proxy in front: never trust X-Forwarded-For (client = socket address).
    uvicorn.run(main.app, host=args.host, port=args.port, workers=1, proxy_headers=False)


if __name__ == "__main__":
    run()
