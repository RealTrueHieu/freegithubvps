import os
import sys
import time
from collections import deque
try:
    from openai import OpenAI
except ImportError:
    print("Error: The 'openai' package is required. Install it using: pip install openai")
    sys.exit(1)

# Enable virtual terminal processing for ANSI escape sequences on Windows
if sys.platform == "win32":
    import ctypes
    kernel32 = ctypes.windll.kernel32
    kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)

# Readline support for history (Up/Down arrow keys)
try:
    import readline
except ImportError:
    try:
        import pyreadline3 as readline
    except ImportError:
        readline = None

# Color definitions
_USE_COLOR = sys.stdout.isatty() and os.getenv("NO_COLOR") is None
def color(code):
    return f"\033[{code}m" if _USE_COLOR else ""

C_RESET = color("0")
C_BOLD = color("1")
C_DIM = color("2")
C_ITALIC = color("3")
C_UNDERLINE = color("4")

# UI Accent Colors
C_PRIMARY = color("38;5;141")  # Purple (Antigravity-like)
C_SUCCESS = color("38;5;120")  # Bright green
C_INFO = color("38;5;75")     # Soft blue
C_WARNING = color("38;5;208")  # Orange
C_ERROR = color("38;5;196")    # Red
C_GRAY = color("90")           # Gray (for reasoning/metadata)
C_USER = color("38;5;81")      # Cyan for User

# Initialize OpenAI client with NVIDIA integrate endpoint
API_KEY = "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"
BASE_URL = "https://integrate.api.nvidia.com/v1"
MODEL_NAME = "z-ai/glm-5.2"

client = OpenAI(
    base_url=BASE_URL,
    api_key=API_KEY
)

# Chat parameters
TEMPERATURE = 0.7
TOP_P = 0.9
MAX_TOKENS = 16384

# System Prompt
DEFAULT_SYSTEM_PROMPT = """You are ZLM, a powerful agentic AI coding assistant.
You provide clean, optimized, and robust code.
Be concise and direct. When asked to debug or write code, format your output cleanly using markdown.
If thinking is required, explain your process step-by-step."""

# Rate Limit tracking (40 requests per minute)
request_history = deque(maxlen=40)
RATE_LIMIT_MAX = 40
RATE_LIMIT_WINDOW = 60 # seconds

def check_rate_limit():
    now = time.time()
    # Remove requests older than 1 minute
    while request_history and now - request_history[0] > RATE_LIMIT_WINDOW:
        request_history.popleft()
    
    current_count = len(request_history)
    if current_count >= RATE_LIMIT_MAX:
        time_to_wait = RATE_LIMIT_WINDOW - (now - request_history[0])
        return False, time_to_wait
    
    request_history.append(now)
    return True, 0

def print_header():
    border = "─" * 62
    print(f"\n{C_PRIMARY}{C_BOLD}╭{border}╮{C_RESET}")
    print(f"{C_PRIMARY}{C_BOLD}│{C_RESET}  {C_BOLD}Z-AI GLM 5.2 AGENT CLI (Antigravity Companion){C_RESET}       {C_PRIMARY}{C_BOLD}│{C_RESET}")
    print(f"{C_PRIMARY}{C_BOLD}│{C_RESET}  {C_DIM}Endpoint: {BASE_URL}{C_RESET}  {C_PRIMARY}{C_BOLD}│{C_RESET}")
    print(f"{C_PRIMARY}{C_BOLD}│{C_RESET}  {C_DIM}Model   : {MODEL_NAME}{C_RESET}                         {C_PRIMARY}{C_BOLD}│{C_RESET}")
    print(f"{C_PRIMARY}{C_BOLD}│{C_RESET}  {C_WARNING}Rate Limit: {RATE_LIMIT_MAX} requests/minute{C_RESET}                      {C_PRIMARY}{C_BOLD}│{C_RESET}")
    print(f"{C_PRIMARY}{C_BOLD}╰{border}╯{C_RESET}")
    print(f"{C_DIM}Type {C_RESET}{C_INFO}/help{C_RESET}{C_DIM} for list of commands. Press Ctrl+C or type {C_RESET}{C_ERROR}/exit{C_RESET}{C_DIM} to quit.{C_RESET}\n")

def print_help():
    print(f"\n{C_BOLD}Available Slash Commands:{C_RESET}")
    print(f"  {C_INFO}/clear{C_RESET}         Clear the terminal screen")
    print(f"  {C_INFO}/system <msg>{C_RESET}  Change or update the System Prompt")
    print(f"  {C_INFO}/info{C_RESET}          Show API information and request rate status")
    print(f"  {C_INFO}/help{C_RESET}          Show this help message")
    print(f"  {C_INFO}/exit{C_RESET} or {C_INFO}/quit{C_RESET}  Quit the session\n")

def print_info():
    now = time.time()
    active_requests = [t for t in request_history if now - t <= RATE_LIMIT_WINDOW]
    print(f"\n{C_BOLD}API Information Status:{C_RESET}")
    print(f"  Model:        {C_SUCCESS}{MODEL_NAME}{C_RESET}")
    print(f"  Rate Limit:   {RATE_LIMIT_MAX} Req / {RATE_LIMIT_WINDOW}s")
    print(f"  Current Rate: {C_WARNING}{len(active_requests)} / {RATE_LIMIT_MAX} requests in last 60s{C_RESET}")
    print(f"  Status:       {C_SUCCESS}Healthy{C_RESET}" if len(active_requests) < RATE_LIMIT_MAX * 0.8 else f"  Status:       {C_WARNING}Near Limit{C_RESET}")
    print()

def main():
    print_header()
    
    # Init conversation history
    system_prompt = DEFAULT_SYSTEM_PROMPT
    messages = [{"role": "system", "content": system_prompt}]
    
    while True:
        try:
            # Styled Prompt
            prompt_prefix = f"\n{C_USER}{C_BOLD}╭─ User{C_RESET}\n{C_USER}{C_BOLD}╰─> {C_RESET}"
            
            # Read input
            user_msg = input(prompt_prefix).strip()
            if not user_msg:
                continue
                
            # Handle Slash Commands
            if user_msg.startswith("/"):
                parts = user_msg.split(" ", 1)
                cmd = parts[0].lower()
                
                if cmd in ["/exit", "/quit"]:
                    print(f"\n{C_INFO}Exiting ZLM Agent. Goodbye!{C_RESET}")
                    break
                elif cmd == "/clear":
                    os.system("cls" if sys.platform == "win32" else "clear")
                    print_header()
                    continue
                elif cmd == "/help":
                    print_help()
                    continue
                elif cmd == "/info":
                    print_info()
                    continue
                elif cmd == "/system":
                    if len(parts) < 2:
                        print(f"\nCurrent System Prompt:\n{C_DIM}{system_prompt}{C_RESET}\n")
                    else:
                        system_prompt = parts[1]
                        messages[0] = {"role": "system", "content": system_prompt}
                        print(f"\n{C_SUCCESS}System prompt updated successfully!{C_RESET}\n")
                    continue
                else:
                    print(f"\n{C_ERROR}Unknown command: {cmd}. Type /help for assistance.{C_RESET}\n")
                    continue

            # Check Rate Limit
            allowed, wait_time = check_rate_limit()
            if not allowed:
                print(f"\n{C_ERROR}⚠ Rate Limit Reached!{C_RESET} Please wait {C_WARNING}{wait_time:.1f}s{C_RESET} before sending another request.\n")
                continue

            # Add to messages
            messages.append({"role": "user", "content": user_msg})
            
            # Call API
            print(f"{C_DIM}Streaming response...{C_RESET}")
            
            start_time = time.time()
            completion = client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages,
                temperature=TEMPERATURE,
                top_p=TOP_P,
                max_tokens=MAX_TOKENS,
                seed=42,
                stream=True
            )
            
            print(f"\n{C_SUCCESS}{C_BOLD}╭─ ZLM{C_RESET}")
            
            current_mode = "content"
            full_response = ""
            
            for chunk in completion:
                if not getattr(chunk, "choices", None):
                    continue
                if len(chunk.choices) == 0 or getattr(chunk.choices[0], "delta", None) is None:
                    continue
                delta = chunk.choices[0].delta
                
                reasoning = getattr(delta, "reasoning_content", None)
                content = getattr(delta, "content", None)
                
                if reasoning:
                    if current_mode != "reasoning":
                        print(C_GRAY, end="", flush=True)
                        current_mode = "reasoning"
                    print(reasoning, end="", flush=True)
                elif content:
                    if current_mode != "content":
                        print(C_RESET, end="", flush=True)
                        current_mode = "content"
                    print(content, end="", flush=True)
                    full_response += content
            
            # Reset text color and end response block
            print(C_RESET)
            print(f"{C_SUCCESS}{C_BOLD}╰─{C_RESET} {C_DIM}[Duration: {time.time() - start_time:.2f}s]{C_RESET}")
            
            # Save assistant response to conversation history
            messages.append({"role": "assistant", "content": full_response})
            
        except KeyboardInterrupt:
            print(f"\n\n{C_WARNING}Session interrupted. Type /exit to quit.{C_RESET}")
        except Exception as e:
            print(f"\n{C_ERROR}API Error: {e}{C_RESET}\n")

if __name__ == "__main__":
    main()
