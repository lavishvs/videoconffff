from flask import Flask, render_template, jsonify, request, flash, redirect, url_for, session
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, login_user, login_required, current_user, UserMixin, logout_user
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from sqlalchemy.orm import relationship, DeclarativeBase, Mapped, mapped_column
from sqlalchemy import Integer, String
from google import genai
import os
import re
from datetime import datetime
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
import time
from threading import Lock

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("FLASK_KEY")
WEB_RTC_API = (os.environ.get("AGORA_API") or "").strip()
ROOM_STATE = {}
ROOM_STATE_LOCK = Lock()
ROOM_MEMBER_TIMEOUT = 45
ROOM_MESSAGE_LIMIT = 200

# Configure Flask-Login
login_manager = LoginManager()
login_manager.init_app(app)


@login_manager.user_loader
def load_user(user_id):
    return db.get_or_404(User, user_id)


# New uploads folder for chat files
chat_upload_folder = os.path.join('static', 'uploads')
if not os.path.exists(chat_upload_folder):
    os.makedirs(chat_upload_folder)
app.config['CHAT_UPLOAD_FOLDER'] = chat_upload_folder

# Google Drive API scopes
SCOPES = ['https://www.googleapis.com/auth/drive.file']


# ---------------------------------------- DATABASE -------------------------------------------------------

# CREATE DATABASE
class Base(DeclarativeBase):
    pass


app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DB_URI', 'sqlite:///recording-data.db')
db = SQLAlchemy(model_class=Base)
db.init_app(app)


class User(UserMixin, db.Model):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(100), unique=True)
    password: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(100))
    google_token: Mapped[str] = mapped_column(String(500), nullable=True)  # Store Google OAuth token

    session_records = relationship('SessionRecord', back_populates='user')


class SessionRecord(db.Model):
    __tablename__ = 'session_records'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_name: Mapped[str] = mapped_column(String, nullable=False)
    video_link: Mapped[str] = mapped_column(String, nullable=False)
    participants: Mapped[str] = mapped_column(String, nullable=False)
    messages: Mapped[str] = mapped_column(String, nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, db.ForeignKey('users.id'), nullable=True)

    user = relationship('User', back_populates='session_records')


with app.app_context():
    db.create_all()

# ----------------------------------------- AI LOGIC ------------------------------------------------------

ai_client = None
if GEMINI_API_KEY:
    try:
        ai_client = genai.Client(api_key=GEMINI_API_KEY)
    except Exception as e:
        ai_client = None
        print(f"AI client initialization failed: {e}")
else:
    print("Warning: GEMINI_API_KEY or GOOGLE_API_KEY is not set. AI bot will be unavailable.")


# Function to replace the substring between sub1 and sub2 including the markers
def replace_between_markers(s, start_marker, end_marker, replacement_func):
    start_idx = 0
    while True:
        try:
            start_idx = s.index(start_marker, start_idx)
            end_idx = s.index(end_marker, start_idx + len(start_marker))
            content = s[start_idx + len(start_marker):end_idx]
            formatted_content = replacement_func(content)
            s = s[:start_idx] + formatted_content + s[end_idx + len(end_marker):]
            # Move start_idx past the newly inserted content
            start_idx = start_idx + len(formatted_content)
        except ValueError:
            break
    return s


# Function to format the content
def format_content(content):
    return "<strong>" + content + "</strong>"


def replace_stars_with_bold_numbers(s):
    # Find all the positions of '*'
    star_positions = [i for i, char in enumerate(s) if char == '*']

    # Replace '*' with unique numbers wrapped in <strong> tags
    num = 1
    s_list = list(s)  # Convert string to list for mutable operations
    for pos in star_positions:
        s_list[pos] = f"<strong>{num}</strong>"
        num += 1

    # Join the list back into a string
    return ''.join(s_list)


# ----------------------------------------- GOOGLE AUTH ROUTES -------------------------------------------------

@app.route('/login/google')
def login_google():
    flow = InstalledAppFlow.from_client_config(
        {
            "web": {
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uris": [url_for('auth_google_callback', _external=True)],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        SCOPES
    )
    flow.redirect_uri = url_for('auth_google_callback', _external=True)
    authorization_url, state = flow.authorization_url(
        access_type='offline',
        include_granted_scopes='true'
    )
    session['state'] = state
    return redirect(authorization_url)


@app.route('/auth/google/callback')
def auth_google_callback():
    state = session.get('state')
    flow = InstalledAppFlow.from_client_config(
        {
            "web": {
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uris": [url_for('auth_google_callback', _external=True)],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        SCOPES,
        state=state
    )
    flow.redirect_uri = url_for('auth_google_callback', _external=True)
    authorization_response = request.url
    flow.fetch_token(authorization_response=authorization_response)

    credentials = flow.credentials
    token = credentials.to_json()

    # Get user info
    service = build('drive', 'v3', credentials=credentials)
    user_info = service.about().get(fields='user').execute()
    email = user_info['user']['emailAddress']

    # Check if user exists, if not create one
    result = db.session.execute(db.select(User).where(User.email == email))
    user = result.scalar()
    if not user:
        user = User(
            email=email,
            name=user_info['user'].get('displayName', email.split('@')[0]),
            password=generate_password_hash(str(credentials.refresh_token), method="pbkdf2:sha256", salt_length=8),
            google_token=token
        )
        db.session.add(user)
    else:
        user.google_token = token
    db.session.commit()

    login_user(user)
    return redirect(url_for('home'))


# Agora token generation endpoint
@app.route('/token')
def get_agora_token():
    """Return an RTM or RTC token for Agora.

    Query params:
      - uid: user id (string or number)
      - channel: channel name
      - type: 'rtm' or 'rtc'
      - ttl: token time-to-live in seconds (optional, default 3600)
    """
    app_id = (os.environ.get('AGORA_API') or '').strip()
    app_cert = (os.environ.get('AGORA_APP_CERTIFICATE') or '').strip()
    uid = (request.args.get('uid') or '0').strip()
    channel = (request.args.get('channel') or 'main').strip()
    token_type = (request.args.get('type') or 'rtc').strip().lower()
    try:
        ttl = int(request.args.get('ttl', 3600))
    except Exception:
        ttl = 3600
    ttl = max(60, min(ttl, 24 * 60 * 60))

    if not app_id:
        return jsonify({'error': 'AGORA_API (App ID) must be set in environment.'}), 501

    if token_type not in {'rtc', 'rtm'}:
        return jsonify({'error': 'type must be either rtc or rtm.'}), 400

    if not uid or not channel:
        return jsonify({'error': 'uid and channel are required.'}), 400

    if not app_cert:
        return jsonify({
            'token': None,
            'expire_ts': None,
            'tokenless': True,
            'warning': 'AGORA_APP_CERTIFICATE is not set; tokenless Agora join only works when the Agora project certificate is disabled.'
        })

    # Try to import the Agora token builder library
    try:
        from agora_token_builder import RtcTokenBuilder, RtmTokenBuilder
    except Exception as e:
        return jsonify({'error': 'agora_token_builder not installed. Install with: pip install agora-token-builder'}), 500

    expire_ts = int(time.time()) + ttl

    try:
        role = 1  # Publisher role for RTC, user role for RTM
        if token_type == 'rtm':
            # RTM tokens require the RTM role argument in agora-token-builder.
            token = RtmTokenBuilder.buildToken(app_id, app_cert, uid, role, expire_ts)
        else:
            # The browser joins RTC with the same string uid used by RTM.
            token = RtcTokenBuilder.buildTokenWithAccount(app_id, app_cert, channel, uid, role, expire_ts)
    except Exception as e:
        return jsonify({'error': f'Failed to build token: {e}'}), 500

    return jsonify({'token': token, 'expire_ts': expire_ts})


def _room_state(room_id):
    state = ROOM_STATE.setdefault(room_id, {
        'members': {},
        'messages': [],
        'next_message_id': 1,
        'signals': [],
        'next_signal_id': 1,
    })
    state.setdefault('signals', [])
    state.setdefault('next_signal_id', 1)
    return state


def _prune_room_members(state):
    cutoff = time.time() - ROOM_MEMBER_TIMEOUT
    state['members'] = {
        uid: member for uid, member in state['members'].items()
        if member.get('last_seen', 0) >= cutoff
    }


def _serialise_members(state):
    return [
        {'uid': uid, 'name': member.get('name') or uid}
        for uid, member in sorted(state['members'].items(), key=lambda item: item[1].get('name') or item[0])
    ]


def _normalise_room_user(data):
    uid = str(data.get('uid') or '').strip()
    display_name = str(data.get('displayName') or data.get('display_name') or uid or 'Guest').strip()

    if not uid:
        return None, None

    return uid[:100], display_name[:100] or uid[:100]


@app.route('/api/rooms/<room_id>/join', methods=['POST'])
def join_room_state(room_id):
    data = request.get_json(silent=True) or {}
    uid, display_name = _normalise_room_user(data)
    if not uid:
        return jsonify({'error': 'uid is required'}), 400

    with ROOM_STATE_LOCK:
        state = _room_state(room_id)
        _prune_room_members(state)
        state['members'][uid] = {'name': display_name, 'last_seen': time.time()}
        members = _serialise_members(state)
        messages = state['messages'][-50:]

    return jsonify({'members': members, 'messages': messages})


@app.route('/api/rooms/<room_id>/heartbeat', methods=['POST'])
def heartbeat_room_state(room_id):
    data = request.get_json(silent=True) or {}
    uid, display_name = _normalise_room_user(data)
    if not uid:
        return jsonify({'error': 'uid is required'}), 400

    with ROOM_STATE_LOCK:
        state = _room_state(room_id)
        _prune_room_members(state)
        state['members'][uid] = {'name': display_name, 'last_seen': time.time()}
        members = _serialise_members(state)

    return jsonify({'members': members})


@app.route('/api/rooms/<room_id>/leave', methods=['POST'])
def leave_room_state(room_id):
    data = request.get_json(silent=True) or {}
    uid = str(data.get('uid') or '').strip()

    with ROOM_STATE_LOCK:
        state = _room_state(room_id)
        if uid:
            state['members'].pop(uid, None)
        _prune_room_members(state)
        members = _serialise_members(state)

    return jsonify({'members': members})


@app.route('/api/rooms/<room_id>/state')
def get_room_state(room_id):
    try:
        after = int(request.args.get('after', 0))
    except Exception:
        after = 0

    with ROOM_STATE_LOCK:
        state = _room_state(room_id)
        _prune_room_members(state)
        members = _serialise_members(state)
        new_messages = [message for message in state['messages'] if message['id'] > after]

    return jsonify({'members': members, 'messages': new_messages})


@app.route('/api/rooms/<room_id>/messages', methods=['POST'])
def create_room_message(room_id):
    data = request.get_json(silent=True) or {}
    uid, display_name = _normalise_room_user(data)
    if not uid:
        return jsonify({'error': 'uid is required'}), 400

    message_type = data.get('type') or 'chat'
    if message_type not in {'chat', 'file'}:
        return jsonify({'error': 'Unsupported message type'}), 400

    message = {
        'uid': uid,
        'displayName': display_name,
        'type': message_type,
        'created_at': datetime.utcnow().isoformat(timespec='seconds') + 'Z',
    }

    if message_type == 'chat':
        text = str(data.get('message') or '').strip()
        if not text:
            return jsonify({'error': 'message is required'}), 400
        message['message'] = text[:4000]
    else:
        message['fileUrl'] = str(data.get('fileUrl') or '')
        message['fileName'] = str(data.get('fileName') or 'file')
        message['fileType'] = str(data.get('fileType') or '')
        if not message['fileUrl']:
            return jsonify({'error': 'fileUrl is required'}), 400

    with ROOM_STATE_LOCK:
        state = _room_state(room_id)
        _prune_room_members(state)
        state['members'][uid] = {'name': display_name, 'last_seen': time.time()}
        message['id'] = state['next_message_id']
        state['next_message_id'] += 1
        state['messages'].append(message)
        state['messages'] = state['messages'][-ROOM_MESSAGE_LIMIT:]

    return jsonify({'message': message})


@app.route('/api/rooms/<room_id>/signals')
def get_room_signals(room_id):
    uid = str(request.args.get('uid') or '').strip()
    try:
        after = int(request.args.get('after', 0))
    except Exception:
        after = 0

    if not uid:
        return jsonify({'error': 'uid is required'}), 400

    with ROOM_STATE_LOCK:
        state = _room_state(room_id)
        _prune_room_members(state)
        signals = [
            signal for signal in state['signals']
            if signal['id'] > after
            and signal.get('from') != uid
            and (not signal.get('to') or signal.get('to') == uid)
        ]

    return jsonify({'signals': signals})


@app.route('/api/rooms/<room_id>/signals', methods=['POST'])
def create_room_signal(room_id):
    data = request.get_json(silent=True) or {}
    uid, display_name = _normalise_room_user(data)
    signal_type = str(data.get('signal_type') or data.get('type') or '').strip()
    target_uid = str(data.get('to') or '').strip() or None
    payload = data.get('payload')

    if not uid:
        return jsonify({'error': 'uid is required'}), 400

    if signal_type not in {'peer-ready', 'offer', 'answer', 'candidate', 'peer-left'}:
        return jsonify({'error': 'Unsupported signal type'}), 400

    signal = {
        'from': uid,
        'fromName': display_name,
        'to': target_uid,
        'type': signal_type,
        'payload': payload,
        'created_at': datetime.utcnow().isoformat(timespec='seconds') + 'Z',
    }

    with ROOM_STATE_LOCK:
        state = _room_state(room_id)
        _prune_room_members(state)
        state['members'][uid] = {'name': display_name, 'last_seen': time.time()}
        signal['id'] = state['next_signal_id']
        state['next_signal_id'] += 1
        state['signals'].append(signal)
        state['signals'] = state['signals'][-500:]

    return jsonify({'signal': signal})


# ----------------------------------------- ROUTES -------------------------------------------------

@app.route("/")
def home():
    if current_user.is_authenticated:
        # Fetch recorded sessions for the logged-in user
        user_sessions = db.session.query(SessionRecord).filter_by(user_id=current_user.id).all()
    else:
        user_sessions = []

    return render_template("lobby.html", logged_in=current_user.is_authenticated, user_sessions=user_sessions)


@app.route('/auth')
def auth():
    return render_template('auth.html')


@app.route('/register', methods=["POST"])
def register():
    if request.method == "POST":
        email = request.form.get('email')
        result = db.session.execute(db.select(User).where(User.email == email))
        # Note, email in db is unique so will only have one result.
        user = result.scalar()
        if user:
            # User already exists
            flash("You've already signed up with that email, try again or log in instead!")
            return redirect(url_for('auth'))

        hash_and_salt_password = generate_password_hash(
            request.form.get("password"),
            method="pbkdf2:sha256",
            salt_length=8
        )
        new_user = User(
            name=request.form.get("name"),
            email=request.form.get("email"),
            password=hash_and_salt_password,
        )
        db.session.add(new_user)
        db.session.commit()

        login_user(new_user)
        return redirect(url_for("home"))


@app.route('/login', methods=['POST'])
def login():
    if request.method == "POST":
        email = request.form.get('email')
        password = request.form.get('password')

        # Find user by email entered.
        result = db.session.execute(db.select(User).where(User.email == email))
        user = result.scalar()
        if not user:
            flash("That email does not exists, please try again or register as new user.")
            return redirect(url_for('auth'))

        elif not check_password_hash(user.password, password):
            flash('Password incorrect, please try again.')
            return redirect(url_for('auth'))

        else:
            login_user(user)
            return redirect(url_for('home'))
    return jsonify({'message': 'Invalid credentials'}), 400


@app.route("/room/<invite_code>")
def room(invite_code):
    return render_template("room.html", invite_code=invite_code, api=WEB_RTC_API)


@app.route('/api/bot-response', methods=['POST'])
def bot_response():
    request_data = request.get_json(silent=True) or {}
    user_message = str(request_data.get('message', '')).strip()

    if not user_message:
        return jsonify({'error': 'No message provided.'}), 400

    if not re.search(r'(?i)jarv(?:is|iew)!', user_message):
        return jsonify({'error': 'Message did not trigger AI (use "jarvis!" or "jarview!" prefix).'}), 400

    prompt = re.sub(r'(?i)jarv(?:is|iew)!\s*', '', user_message, count=1).strip()
    prompt = prompt or "Please answer the user briefly."
    prompt = f"{prompt} Please write in short concise points."

    if not ai_client:
        fallback = "Jarvis AI is currently unavailable. Please try again later."
        return jsonify({'bot_message': fallback})

    try:
        chat = ai_client.chats.create(model=GEMINI_MODEL)
        response = chat.send_message(prompt, config={
            'temperature': 0.1,
            'max_output_tokens': 500
        })
        ai_format = getattr(response, 'text', None) or str(response)
        sub1 = "**"
        sub2 = "**"

        formatted_text1 = replace_between_markers(ai_format, sub1, sub2, format_content)
        formatted_text2 = replace_stars_with_bold_numbers(formatted_text1)

        print(formatted_text2)

        return jsonify({'bot_message': formatted_text2})
    except Exception as e:
        print(f"AI error: {e}")
        fallback = "Jarvis AI is currently unavailable. Please try again later."
        return jsonify({'bot_message': fallback})


@app.route('/upload-video', methods=['POST'])
@login_required
def upload_video():
    if 'file' not in request.files:
        return jsonify({'message': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'message': 'No selected file'}), 400
    if file:
        # Check if user has Google token
        if not current_user.google_token:
            return jsonify({'error': 'Please log in with Google to upload to Drive'}), 403

        # Get the original file extension
        _, file_extension = os.path.splitext(file.filename)

        # Generate base filename with current date
        current_date = datetime.now().strftime('%Y-%m-%d')
        base_filename = f"recording-{current_date}"
        filename = f"{base_filename}{file_extension}"

        # Save temporarily on Render
        temp_filepath = os.path.join('/tmp', filename)
        counter = 1
        while os.path.exists(temp_filepath):
            filename = f"{base_filename}({counter}){file_extension}"
            temp_filepath = os.path.join('/tmp', filename)
            counter += 1
        file.save(temp_filepath)

        try:
            # Refresh credentials if needed
            credentials = Credentials.from_authorized_user_info(
                eval(current_user.google_token), SCOPES
            )
            if credentials.expired and credentials.refresh_token:
                credentials.refresh(Request())

            # Build Drive service
            service = build('drive', 'v3', credentials=credentials)

            # Upload to Google Drive
            file_metadata = {
                'name': filename,
                'parents': ['root']  # Save to root of Drive; can create a folder if needed
            }
            media = MediaFileUpload(temp_filepath)
            drive_file = service.files().create(
                body=file_metadata,
                media_body=media,
                fields='id,webViewLink'
            ).execute()

            # Delete temporary file
            os.remove(temp_filepath)

            return jsonify({
                'message': 'File uploaded to Google Drive successfully',
                'file_path': drive_file.get('webViewLink')
            })
        except Exception as e:
            # Clean up in case of error
            if os.path.exists(temp_filepath):
                os.remove(temp_filepath)
            return jsonify({'error': str(e)}), 500


@app.route('/upload-file', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({'message': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'message': 'No selected file'}), 400
    if file:
        # Validate file type
        allowed_types = ['image/jpeg', 'image/png', 'application/pdf', 'text/plain']
        if file.mimetype not in allowed_types:
            return jsonify({'message': 'Invalid file type. Only JPEG, PNG, PDF, TXT allowed.'}), 400
        # Validate file size (10MB)
        file.seek(0, os.SEEK_END)
        file_size = file.tell()
        if file_size > 10 * 1024 * 1024:
            return jsonify({'message': 'File too large. Max size is 10MB.'}), 400
        file.seek(0)  # Reset file pointer
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['CHAT_UPLOAD_FOLDER'], filename)
        file.save(filepath)
        file_url = url_for('static', filename=f'uploads/{filename}', _external=True)
        return jsonify({'message': 'File uploaded successfully', 'file_url': file_url, 'file_name': filename,
                        'file_type': file.mimetype})


@app.route('/record-session', methods=['POST'])
@login_required
def record_session():
    data = request.get_json()
    channel_name = data['channel_name']
    video_link = data['video_link']
    participants = data['participants']
    messages = data['messages']
    new_record = SessionRecord(
        channel_name=channel_name,
        video_link=video_link,  # This will now be a Google Drive link
        participants=participants,
        messages=messages,
        user_id=current_user.id
    )
    db.session.add(new_record)
    db.session.commit()
    return jsonify({'message': 'Session recorded successfully'})


@app.route('/logout')
def logout():
    logout_user()
    return redirect(url_for("home"))


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))
