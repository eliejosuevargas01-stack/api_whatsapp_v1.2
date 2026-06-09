import sys
import json
import os
import time
from instagrapi import Client
from instagrapi.exceptions import ChallengeRequired, LoginRequired, UserNotFound, ClientNotFoundError

SESSIONS_DIR = os.environ.get("SESSIONS_DIR", "sessions")

def challenge_code_handler(username, choice):
    # Print status to stdout for Node to detect
    print(json.dumps({"status": "challenge_required", "choice": str(choice), "username": username}))
    sys.stdout.flush()
    
    # Wait/poll for the code file
    code_filepath = os.path.join(SESSIONS_DIR, f"challenge_code_{username}.txt")
    start_time = time.time()
    
    # Poll for up to 90 seconds
    while time.time() - start_time < 90:
        if os.path.exists(code_filepath):
            try:
                with open(code_filepath, "r") as f:
                    code = f.read().strip()
                os.remove(code_filepath)
                if code:
                    return code
            except Exception:
                pass
        time.sleep(1)
        
    return False

def get_client(username=None):
    cl = Client()
    if username:
        cl.challenge_code_handler = lambda choice: challenge_code_handler(username, choice)
    return cl

def resolve_user_id(cl, username):
    try:
        return cl.user_id_from_username(username)
    except (UserNotFound, ClientNotFoundError):
        raise UserNotFound(f"Usuario '{username}' nao encontrado no Instagram")
    except Exception as e:
        err_msg = str(e).lower()
        if "does not exist" in err_msg or "not found" in err_msg or "404" in err_msg:
            raise UserNotFound(f"Usuario '{username}' nao encontrado no Instagram")
        
        is_exact_match = False
        try:
            results = cl.search_users(username)
            is_exact_match = any(u.username.lower() == username.lower() for u in results)
        except Exception:
            pass
        else:
            if not is_exact_match:
                raise UserNotFound(f"Usuario '{username}' nao encontrado no Instagram")
                
        raise e


def extract_username(input_str):
    if not input_str:
        return ""
    input_str = input_str.strip()
    import re
    # Matches: https://instagram.com/username, http://www.instagram.com/username, instagram.com/username etc.
    match = re.search(r'(?:https?://)?(?:www\.)?instagram\.com/([a-zA-Z0-9_\.]+)', input_str, re.IGNORECASE)
    if match:
        return match.group(1)
    if input_str.startswith('@'):
        return input_str[1:]
    return input_str

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "message": "Faltando argumentos"}))
        return

    command = sys.argv[1]
    
    # Ensure sessions directory exists
    os.makedirs(SESSIONS_DIR, exist_ok=True)

    try:
        if command == "login":
            if len(sys.argv) < 4:
                print(json.dumps({"success": False, "message": "Informe username e password"}))
                return
            username = sys.argv[2]
            password = sys.argv[3]
            
            cl = get_client(username)
            session_path = os.path.join(SESSIONS_DIR, f"instagrapi_{username}.json")
            
            if os.path.exists(session_path):
                try:
                    cl.load_settings(session_path)
                except Exception:
                    pass
            
            try:
                auth = cl.login(username, password)
                cl.dump_settings(session_path)
                print(json.dumps({"success": True, "session_id": username}))
            except Exception as e:
                # Check if it was caught by challenge_code_handler and processed
                if os.path.exists(session_path):
                    print(json.dumps({"success": True, "session_id": username}))
                else:
                    raise e
                    
        elif command == "challenge_code":
            # Just write the code to the file so the polling login process reads it
            if len(sys.argv) < 4:
                print(json.dumps({"success": False, "message": "Informe username e o codigo"}))
                return
            username = sys.argv[2]
            code = sys.argv[3]
            
            code_filepath = os.path.join(SESSIONS_DIR, f"challenge_code_{username}.txt")
            with open(code_filepath, "w") as f:
                f.write(code)
            print(json.dumps({"success": True, "message": "Codigo enviado"}))

        elif command == "send_message":
            if len(sys.argv) < 5:
                print(json.dumps({"success": False, "message": "Informe username, username_to e text"}))
                return
            username = sys.argv[2]
            username_to = sys.argv[3]
            text = sys.argv[4]
            
            cl = get_client(username)
            session_path = os.path.join(SESSIONS_DIR, f"instagrapi_{username}.json")
            
            if not os.path.exists(session_path):
                print(json.dumps({"success": False, "session_invalid": True, "message": "Sessao nao encontrada"}))
                return
                
            cl.load_settings(session_path)
            
            # Verify session is valid
            try:
                cl.get_timeline_feed()
            except LoginRequired:
                if os.path.exists(session_path):
                    os.remove(session_path)
                print(json.dumps({"success": False, "session_invalid": True, "message": "Sessao expirada ou invalida"}))
                return
                
            username_to = extract_username(username_to)
            user_id = resolve_user_id(cl, username_to)
            cl.direct_send(text, user_ids=[int(user_id)])
            
            # Dump settings again to preserve cookie updates
            cl.dump_settings(session_path)
            print(json.dumps({"success": True}))
 
        elif command == "send_thread_message":
            if len(sys.argv) < 5:
                print(json.dumps({"success": False, "message": "Informe username, thread_id e text"}))
                return
            username = sys.argv[2]
            thread_id = sys.argv[3]
            text = sys.argv[4]
            
            cl = get_client(username)
            session_path = os.path.join(SESSIONS_DIR, f"instagrapi_{username}.json")
            
            if not os.path.exists(session_path):
                print(json.dumps({"success": False, "session_invalid": True, "message": "Sessao nao encontrada"}))
                return
                
            cl.load_settings(session_path)
            
            # Verify session
            try:
                cl.get_timeline_feed()
            except LoginRequired:
                if os.path.exists(session_path):
                    os.remove(session_path)
                print(json.dumps({"success": False, "session_invalid": True, "message": "Sessao expirada ou invalida"}))
                return
                
            cl.direct_send(text, thread_ids=[int(thread_id)])
            cl.dump_settings(session_path)
            print(json.dumps({"success": True}))
 
        elif command == "conversations":
            if len(sys.argv) < 3:
                print(json.dumps({"success": False, "message": "Informe username"}))
                return
            username = sys.argv[2]
            
            cl = get_client(username)
            session_path = os.path.join(SESSIONS_DIR, f"instagrapi_{username}.json")
            
            if not os.path.exists(session_path):
                print(json.dumps({"success": False, "session_invalid": True, "message": "Sessao nao encontrada"}))
                return
                
            cl.load_settings(session_path)
            
            try:
                threads = cl.direct_threads(amount=20)
            except LoginRequired:
                if os.path.exists(session_path):
                    os.remove(session_path)
                print(json.dumps({"success": False, "session_invalid": True, "message": "Sessao expirada ou invalida"}))
                return
                
            conversations = []
            for t in threads:
                title = t.thread_title
                if not title and t.users:
                    title = ", ".join([u.full_name or u.username for u in t.users])
                if not title:
                    title = f"Conversa {t.id}"
                    
                preview = ""
                if t.messages:
                    preview = t.messages[0].text or ""
                    
                conversations.append({
                    "jid": str(t.id),
                    "title": title,
                    "preview": preview,
                    "unreadCount": 1 if t.read_state else 0,
                    "lastMessageTimestamp": time.mktime(t.last_activity_at.timetuple()) if t.last_activity_at else None
                })
                
            print(json.dumps({"success": True, "conversations": conversations}))

        elif command == "messages":
            if len(sys.argv) < 4:
                print(json.dumps({"success": False, "message": "Informe username e thread_id"}))
                return
            username = sys.argv[2]
            thread_id = sys.argv[3]
            
            cl = get_client(username)
            session_path = os.path.join(SESSIONS_DIR, f"instagrapi_{username}.json")
            
            if not os.path.exists(session_path):
                print(json.dumps({"success": False, "session_invalid": True, "message": "Sessao nao encontrada"}))
                return
                
            cl.load_settings(session_path)
            
            try:
                items = cl.direct_messages(thread_id, amount=50)
            except LoginRequired:
                if os.path.exists(session_path):
                    os.remove(session_path)
                print(json.dumps({"success": False, "session_invalid": True, "message": "Sessao expirada ou invalida"}))
                return
                
            messages = []
            # instagrapi returns user_id as an integer or string depending on version, let's convert to string
            my_user_id = str(cl.user_id)
            for item in items:
                messages.append({
                    "id": str(item.id),
                    "fromMe": str(item.user_id) == my_user_id,
                    "text": item.text or "",
                    "timestamp": time.mktime(item.timestamp.timetuple()) if item.timestamp else None
                })
            messages.reverse()
            print(json.dumps({"success": True, "messages": messages}))
            
        else:
            print(json.dumps({"success": False, "message": f"Comando desconhecido: {command}"}))

    except ChallengeRequired as e:
        print(json.dumps({"success": False, "isCheckpoint": True, "message": "O Instagram solicitou verificacao (Checkpoint)"}))
    except UserNotFound as e:
        print(json.dumps({"success": False, "error_code": "user_not_found", "message": str(e)}))
    except Exception as e:
        msg = str(e).lower()
        if "challenge" in msg or "checkpoint" in msg:
            print(json.dumps({"success": False, "isCheckpoint": True, "message": "O Instagram solicitou verificacao (Checkpoint)"}))
        else:
            print(json.dumps({"success": False, "message": str(e)}))

if __name__ == "__main__":
    main()
