"""Эко-Монитор: сайт, который принимает показания с ESP32 и показывает качество воздуха."""
import csv
import hmac
import io
import math
import os
import secrets
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from flask import (Flask, Response, flash, g, jsonify, redirect, render_template,
                   request, session, url_for)
from flask_login import (LoginManager, UserMixin, current_user, login_required,
                         login_user, logout_user)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent


# ---------- НАСТРОЙКИ ----------
# Все настройки необязательные: без них проект работает как обычно.
def load_secret_key():
    """Берёт ключ сессий из настроек, а если его нет, создаёт и хранит в файле .secret_key."""
    key = os.environ.get('ECO_SECRET_KEY')
    if key:
        return key
    key_file = BASE_DIR / '.secret_key'
    if not key_file.exists():
        key_file.write_text(secrets.token_hex(32), encoding='ascii')
    return key_file.read_text(encoding='ascii').strip()


app = Flask(__name__)
app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_SAMESITE='Lax',
    MAX_CONTENT_LENGTH=64 * 1024,
    # Абсолютный путь: база одна и та же, из какой бы папки ни запускали сайт
    DATABASE=str(BASE_DIR / os.environ.get('ECO_DATABASE', 'sensor_data.db')),
    # Если ключ задан, ESP32 должна присылать его в заголовке X-API-Key
    API_KEY=os.environ.get('ECO_API_KEY', ''),
    ALLOW_REGISTRATION=os.environ.get('ECO_ALLOW_REGISTRATION', '1') != '0',
    # Сколько секунд без новых показаний считать, что прибор не на связи
    DEVICE_TIMEOUT=int(os.environ.get('ECO_DEVICE_TIMEOUT', '120')),
    # Галочка «Запомнить меня» держит вход месяц, даже если браузер закрывали
    REMEMBER_COOKIE_DURATION=timedelta(days=30),
    REMEMBER_COOKIE_SAMESITE='Lax',
)

login_manager = LoginManager()
login_manager.init_app(app)

TIME_FORMAT = '%Y-%m-%d %H:%M:%S'
EPOCH = datetime(1970, 1, 1)


# ---------- ПОКАЗАТЕЛИ И ИХ ГРАНИЦЫ ----------
# Границы ориентировочные, их можно менять здесь: сайт подстроится сам.
# Зона: (верхняя граница, уровень, подпись, совет). None означает «без верхней границы».
# about объясняет показатель простыми словами, unit_hint расшифровывает непривычную единицу.
METRICS = {
    'temperature': {
        'label': 'Температура', 'unit': '°C', 'decimals': 1,
        'about': 'При комфортной температуре легче сосредоточиться: в жаре клонит в сон, '
                 'а в холоде трудно усидеть на месте.',
        'allowed': (-40, 125), 'scale': (10, 35),
        'zones': [
            (16, 'danger', 'Холодно', 'В помещении холодно'),
            (18, 'warn', 'Прохладно', 'В помещении прохладно'),
            (24, 'good', 'Норма', None),
            (28, 'warn', 'Тепло', 'В помещении тепло, стоит проветрить'),
            (None, 'danger', 'Жарко', 'В помещении жарко, нужно проветрить'),
        ],
    },
    'humidity': {
        'label': 'Влажность', 'unit': '%', 'decimals': 0,
        'about': 'Сухой воздух сушит кожу и горло, а в слишком влажном появляется плесень. '
                 'Лучше всего золотая середина.',
        'allowed': (0, 100), 'scale': (0, 100),
        'zones': [
            (30, 'danger', 'Очень сухо', 'Воздух очень сухой, нужен увлажнитель'),
            (40, 'warn', 'Сухо', 'Воздух суховат'),
            (60, 'good', 'Норма', None),
            (70, 'warn', 'Влажно', 'Воздух влажный, стоит проветрить'),
            (None, 'danger', 'Очень влажно', 'Воздух слишком влажный, нужно проветрить'),
        ],
    },
    'co2': {
        'label': 'CO₂', 'unit': 'ppm', 'decimals': 0,
        'about': 'Углекислый газ мы выдыхаем сами. Когда его много, становится душно, '
                 'клонит в сон и труднее думать. Помогает проветривание.',
        'unit_hint': 'Единица ppm показывает, сколько молекул газа приходится '
                     'на миллион молекул воздуха.',
        'allowed': (0, 20000), 'scale': (400, 2000),
        'zones': [
            (800, 'good', 'Норма', None),
            (1200, 'warn', 'Повышен', 'Скоро пора проветривать'),
            (None, 'danger', 'Высокий', 'Пора проветрить помещение'),
        ],
    },
    'dust': {
        'label': 'Пыль', 'unit': 'мкг/м³', 'decimals': 0,
        'about': 'Мелкая пыль почти не видна, но попадает в лёгкие. '
                 'Её становится меньше после влажной уборки.',
        'unit_hint': 'Единица мкг/м³ показывает, сколько микрограммов пыли '
                     'в одном кубометре воздуха.',
        'allowed': (0, 5000), 'scale': (0, 150),
        'zones': [
            (35, 'good', 'Норма', None),
            (75, 'warn', 'Повышена', 'Пыли больше обычного, поможет влажная уборка'),
            (None, 'danger', 'Высокая', 'Много пыли, нужна влажная уборка'),
        ],
    },
}
LEVEL_ORDER = {'good': 0, 'warn': 1, 'danger': 2}

# Период графика: (длина, шаг усреднения в секундах)
RANGES = {
    '1h': (timedelta(hours=1), 60),
    '24h': (timedelta(hours=24), 600),
    '7d': (timedelta(days=7), 3600),
    '30d': (timedelta(days=30), 6 * 3600),
}
RANGE_LABELS = {'1h': 'Час', '24h': 'Сутки', '7d': 'Неделя', '30d': 'Месяц'}

# С чем сравнивать последнее показание, чтобы понять, растёт значение или падает:
# со средним за окно от 20 до 10 минут до него
TREND_WINDOW = (timedelta(minutes=20), timedelta(minutes=10))


def find_zone(metric, value):
    for upper, level, label, advice in METRICS[metric]['zones']:
        if upper is None or value < upper:
            return {'level': level, 'label': label, 'advice': advice}
    raise ValueError(f'В показателе {metric} нет последней зоны без верхней границы')


def describe_air(row):
    """Оценивает показания: что с каждым показателем и какой общий вывод."""
    levels = {}
    for metric in METRICS:
        if row[metric] is not None:
            levels[metric] = find_zone(metric, row[metric])

    if not levels:
        return {}, {'level': 'unknown', 'title': 'Датчики не прислали значений', 'advice': []}

    worst = max(LEVEL_ORDER[zone['level']] for zone in levels.values())
    problems = sorted(
        (zone for zone in levels.values() if zone['advice']),
        key=lambda zone: -LEVEL_ORDER[zone['level']],
    )
    if not problems:
        summary = {'level': 'good', 'title': 'Воздух в норме', 'advice': []}
    else:
        summary = {
            'level': next(name for name, order in LEVEL_ORDER.items() if order == worst),
            'title': problems[0]['advice'],
            'advice': [zone['advice'] for zone in problems[1:]],
        }
    return levels, summary


# ---------- БАЗА ДАННЫХ ----------
def get_db():
    """Одно соединение на запрос; закрывается в close_db."""
    if 'db' not in g:
        g.db = sqlite3.connect(app.config['DATABASE'])
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exception=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db():
    with app.app_context():
        db = get_db()
        db.execute('''
            CREATE TABLE IF NOT EXISTS measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                temperature REAL,
                humidity REAL,
                co2 REAL,
                dust REAL,
                created_at TEXT
            )
        ''')
        db.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL
            )
        ''')
        # Индекс ускоряет выборки за период, когда измерений станет много
        db.execute('CREATE INDEX IF NOT EXISTS idx_measurements_created_at '
                   'ON measurements (created_at)')
        db.commit()


# ---------- МОДЕЛЬ ПОЛЬЗОВАТЕЛЯ ----------
class User(UserMixin):
    def __init__(self, row):
        self.id = row['id']
        self.username = row['username']
        self.password_hash = row['password_hash']

    @staticmethod
    def get_by_id(user_id):
        row = get_db().execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        return User(row) if row else None

    @staticmethod
    def get_by_username(username):
        row = get_db().execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
        return User(row) if row else None

    @staticmethod
    def create(username, password):
        db = get_db()
        try:
            db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)',
                       (username, generate_password_hash(password)))
            db.commit()
            return True
        except sqlite3.IntegrityError:
            return False


@login_manager.user_loader
def load_user(user_id):
    return User.get_by_id(int(user_id))


@login_manager.unauthorized_handler
def handle_unauthorized():
    # Страница панели должна получить именно 401, а не HTML формы входа
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Нужно войти в систему'}), 401
    return redirect(url_for('login'))


# ---------- ЗАЩИТА ФОРМ (CSRF) ----------
def csrf_token():
    if 'csrf_token' not in session:
        session['csrf_token'] = secrets.token_urlsafe(32)
    return session['csrf_token']


app.jinja_env.globals['csrf_token'] = csrf_token


def same_text(a, b):
    return hmac.compare_digest(a.encode('utf-8'), b.encode('utf-8'))


@app.before_request
def check_csrf():
    # /api/data вызывает ESP32: у неё нет сессии, поэтому там своя проверка по ключу
    if request.method != 'POST' or request.endpoint == 'receive_data':
        return None
    expected = session.get('csrf_token', '')
    sent = request.form.get('csrf_token', '')
    if not expected or not same_text(expected, sent):
        flash('Страница устарела. Повторите действие ещё раз.', 'error')
        return redirect(url_for('index') if current_user.is_authenticated else url_for('login'))
    return None


# ---------- МАРШРУТЫ АВТОРИЗАЦИИ ----------
@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if not app.config['ALLOW_REGISTRATION']:
        flash('Регистрация новых пользователей отключена.', 'info')
        return redirect(url_for('login'))

    username = ''
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        confirm = request.form.get('password_confirm', '')
        if not 3 <= len(username) <= 32:
            flash('Имя пользователя должно содержать от 3 до 32 символов.', 'error')
        elif not 6 <= len(password) <= 128:
            flash('Пароль должен содержать от 6 до 128 символов.', 'error')
        elif password != confirm:
            flash('Пароли не совпадают.', 'error')
        elif User.create(username, password):
            # Сразу впускаем на сайт: вводить только что придуманный пароль второй раз незачем
            session.pop('csrf_token', None)
            login_user(User.get_by_username(username))
            flash('Аккаунт создан. Добро пожаловать!', 'success')
            return redirect(url_for('index'))
        else:
            flash('Это имя пользователя уже занято.', 'error')
    return render_template('register.html', username=username)


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    username = ''
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        user = User.get_by_username(username)
        if user and check_password_hash(user.password_hash, password):
            session.pop('csrf_token', None)  # после входа токен формы создаётся заново
            login_user(user, remember=request.form.get('remember') == '1')
            return redirect(url_for('index'))
        flash('Неверное имя пользователя или пароль.', 'error')
    return render_template('login.html', username=username,
                           allow_registration=app.config['ALLOW_REGISTRATION'])


@app.route('/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    flash('Вы вышли из системы.', 'info')
    return redirect(url_for('login'))


# ---------- ГЛАВНАЯ ----------
def good_range(metric):
    """Границы зоны «норма»: (нижняя или None, верхняя или None)."""
    low = None
    for upper, level, _label, _advice in METRICS[metric]['zones']:
        if level == 'good':
            return low, upper
        low = upper
    return None, None


def page_metrics():
    """Описание показателей для страниц: без допустимых пределов приёма данных."""
    names = ('label', 'unit', 'decimals', 'scale', 'zones', 'about')
    return {
        key: {**{name: meta[name] for name in names}, 'unit_hint': meta.get('unit_hint', '')}
        for key, meta in METRICS.items()
    }


def render_landing():
    norms = {key: good_range(key) for key in METRICS}
    return render_template('landing.html', metrics=page_metrics(), norms=norms,
                           allow_registration=app.config['ALLOW_REGISTRATION'])


def render_dashboard(is_demo):
    return render_template('index.html', metrics=page_metrics(), ranges=RANGE_LABELS,
                           demo=is_demo)


@app.route('/')
def index():
    # Гостям показываем рассказ о проекте, панель с показаниями только после входа
    if not current_user.is_authenticated:
        return render_landing()
    return render_dashboard(is_demo=False)


@app.route('/about')
def about():
    # Тот же рассказ о проекте, но доступный и после входа
    return render_landing()


@app.route('/demo')
def demo():
    # Та же панель, но с придуманными показаниями: посмотреть сайт можно без прибора и без входа
    return render_dashboard(is_demo=True)


# ---------- API ДЛЯ ПРИЁМА ДАННЫХ С ESP32 ----------
def parse_reading(metric, value):
    """Возвращает (число или None, принято ли значение)."""
    if value is None:
        return None, True
    if isinstance(value, bool):
        return None, False
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None, False
    if math.isnan(number):
        return None, True  # так DHT22 сообщает о неудачном чтении
    low, high = METRICS[metric]['allowed']
    if not low <= number <= high:  # бесконечность сюда тоже попадает
        return None, False
    return number, True


@app.route('/api/data', methods=['POST'])
def receive_data():
    api_key = app.config['API_KEY']
    if api_key and not same_text(api_key, request.headers.get('X-API-Key', '')):
        return jsonify({'error': 'Неверный ключ прибора'}), 401

    # force=True: некоторые прошивки не указывают Content-Type
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Нужен JSON с полями temperature, humidity, co2, dust'}), 400

    # Сбой одного датчика не должен лишать нас показаний остальных
    values, rejected = {}, []
    for metric in METRICS:
        values[metric], accepted = parse_reading(metric, data.get(metric))
        if not accepted:
            rejected.append(metric)

    if all(value is None for value in values.values()):
        return jsonify({'error': 'Нет ни одного корректного значения', 'rejected': rejected}), 400

    db = get_db()
    db.execute(
        'INSERT INTO measurements (temperature, humidity, co2, dust, created_at) '
        'VALUES (?, ?, ?, ?, ?)',
        (values['temperature'], values['humidity'], values['co2'], values['dust'],
         datetime.now().strftime(TIME_FORMAT)),
    )
    db.commit()
    response = {'status': 'ok'}
    if rejected:
        response['rejected'] = rejected
    return jsonify(response), 200


# ---------- API ДЛЯ ПАНЕЛИ (только для авторизованных) ----------
@app.route('/api/latest')
@login_required
def latest():
    row = get_db().execute('SELECT * FROM measurements ORDER BY id DESC LIMIT 1').fetchone()
    if row is None:
        return jsonify({})
    result = dict(row)
    age = datetime.now() - datetime.strptime(row['created_at'], TIME_FORMAT)
    result['age_seconds'] = max(0, int(age.total_seconds()))
    result['online'] = result['age_seconds'] <= app.config['DEVICE_TIMEOUT']
    result['levels'], result['summary'] = describe_air(result)
    result['trends'] = find_trends(row)
    return jsonify(result)


def find_trends(row):
    """На сколько изменился каждый показатель примерно за 15 минут."""
    moment = datetime.strptime(row['created_at'], TIME_FORMAT)
    since, until = (moment - offset for offset in TREND_WINDOW)
    averages = ', '.join(f'AVG({metric}) AS {metric}' for metric in METRICS)
    earlier = get_db().execute(
        f'SELECT {averages} FROM measurements WHERE created_at BETWEEN ? AND ?',
        (since.strftime(TIME_FORMAT), until.strftime(TIME_FORMAT)),
    ).fetchone()
    return {
        metric: round(row[metric] - earlier[metric], 2)
        for metric in METRICS
        if row[metric] is not None and earlier[metric] is not None
    }


def to_epoch(moment):
    return int((moment - EPOCH).total_seconds())


def bad_range_response():
    return jsonify({'error': f'Период может быть только таким: {", ".join(RANGES)}'}), 400


@app.route('/api/history')
@login_required
def history():
    range_key = request.args.get('range', '1h')
    if range_key not in RANGES:
        return bad_range_response()

    span, step = RANGES[range_key]
    now = datetime.now()
    start = now - span
    start_text = start.strftime(TIME_FORMAT)
    db = get_db()

    # Названия колонок берутся только из METRICS, данные пользователя в запрос не попадают
    averages = ', '.join(f'AVG({metric}) AS {metric}' for metric in METRICS)
    rows = db.execute(
        f"SELECT CAST(strftime('%s', created_at) AS INTEGER) / ? AS bucket, {averages} "
        'FROM measurements WHERE created_at >= ? GROUP BY bucket',
        (step, start_text),
    ).fetchall()
    by_bucket = {row['bucket']: row for row in rows}

    # Точка есть на каждый шаг: там, где прибор молчал, на графике будет разрыв
    points = []
    for bucket in range(to_epoch(start) // step, to_epoch(now) // step + 1):
        row = by_bucket.get(bucket)
        point = {'created_at': (EPOCH + timedelta(seconds=bucket * step)).strftime(TIME_FORMAT)}
        for metric in METRICS:
            value = row[metric] if row else None
            point[metric] = round(value, 2) if value is not None else None
        points.append(point)

    columns = ', '.join(
        f'MIN({m}) AS {m}_min, AVG({m}) AS {m}_avg, MAX({m}) AS {m}_max' for m in METRICS
    )
    totals = db.execute(f'SELECT {columns} FROM measurements WHERE created_at >= ?',
                        (start_text,)).fetchone()
    stats = {}
    for metric in METRICS:
        if totals[f'{metric}_avg'] is not None:
            stats[metric] = {kind: round(totals[f'{metric}_{kind}'], 2)
                             for kind in ('min', 'avg', 'max')}

    return jsonify({'range': range_key, 'points': points, 'stats': stats})


@app.route('/export.csv')
@login_required
def export_csv():
    range_key = request.args.get('range', '24h')
    if range_key not in RANGES:
        return bad_range_response()

    start = (datetime.now() - RANGES[range_key][0]).strftime(TIME_FORMAT)
    rows = get_db().execute(
        'SELECT created_at, temperature, humidity, co2, dust FROM measurements '
        'WHERE created_at >= ? ORDER BY id',
        (start,),
    ).fetchall()

    def cell(value):
        return '' if value is None else str(value).replace('.', ',')

    # Точка с запятой, запятая в дробях и BOM: так файл правильно открывается в русском Excel
    output = io.StringIO()
    output.write('﻿')
    writer = csv.writer(output, delimiter=';', lineterminator='\r\n')
    writer.writerow(['Время', 'Температура, °C', 'Влажность, %', 'CO2, ppm', 'Пыль, мкг/м³'])
    for row in rows:
        writer.writerow([row['created_at'], cell(row['temperature']), cell(row['humidity']),
                         cell(row['co2']), cell(row['dust'])])

    filename = f'eco-monitor_{range_key}_{datetime.now():%Y-%m-%d}.csv'
    return Response(output.getvalue(), mimetype='text/csv; charset=utf-8',
                    headers={'Content-Disposition': f'attachment; filename="{filename}"'})


# ---------- ДЕМО БЕЗ ПРИБОРА (открыто всем) ----------
# Показания для демо считаются по формулам от времени, поэтому не нужны ни прибор, ни база,
# а график за любой период выглядит правдоподобно. Настоящие измерения сюда не попадают.
DEMO_SAMPLES = 7  # в скольких точках считаем формулу внутри одного шага графика


def ramp(value, start, end):
    """Плавный переход от 0 к 1, пока value идёт от start до end."""
    return min(max((value - start) / (end - start), 0), 1)


def demo_reading(moment):
    """Придуманные показания «обычного школьного дня» на заданный момент."""
    minutes = moment.hour * 60 + moment.minute + moment.second / 60
    hour = minutes / 60
    days = moment.timestamp() / 86400
    warmth = math.sin((hour - 9) / 24 * 2 * math.pi)  # днём теплее, ночью прохладнее
    busy = 0.25 + 0.75 * ramp(hour, 6.5, 7.5) * (1 - ramp(hour, 22.5, 23.5))  # ночью пусто
    crowd = 0.95 + 0.2 * math.sin(days * 4.1)  # дни не похожи друг на друга
    # «Урок» 45 минут: воздух постепенно «надышивают», потом 15 минут проветривают
    cycle = minutes % 60
    stuffy = (cycle / 45 if cycle < 45 else 1 - (cycle - 45) / 15) * busy * crowd
    sweeping = max(0, math.sin((minutes - 40) / 360 * 2 * math.pi)) ** 16  # изредка поднимают пыль

    def jitter(salt):
        # Мелкая дрожь, как у настоящих датчиков: случайная на вид, но одна и та же для момента
        slot = int(moment.timestamp()) // 5
        return math.sin(slot * 12.9898 + salt * 78.233) * 43758.5453 % 1 - 0.5

    return {
        'temperature': round(21.6 + 1.3 * warmth + 1.5 * stuffy + 0.2 * jitter(1), 1),
        'humidity': round(47 - 4 * warmth + 4 * stuffy + jitter(2), 1),
        'co2': round(520 + 780 * stuffy + 24 * jitter(3)),
        'dust': round(12 + 8 * busy * abs(math.sin(minutes / 37)) + 34 * busy * sweeping
                      + 3 * jitter(4)),
    }


def demo_average(start, seconds, now):
    """Средние демо-показания за отрезок. В будущее не заглядываем: его ещё не было."""
    samples = [
        demo_reading(min(start + timedelta(seconds=seconds * (i + 0.5) / DEMO_SAMPLES), now))
        for i in range(DEMO_SAMPLES)
    ]
    return {metric: round(sum(sample[metric] for sample in samples) / DEMO_SAMPLES, 2)
            for metric in METRICS}


@app.route('/api/demo/latest')
def demo_latest():
    now = datetime.now().replace(microsecond=0)
    sent = now - timedelta(seconds=now.second % 5)  # «прибор» присылает данные раз в 5 секунд
    result = {'id': 0, **demo_reading(sent), 'created_at': sent.strftime(TIME_FORMAT),
              'age_seconds': (now - sent).seconds, 'online': True}
    result['levels'], result['summary'] = describe_air(result)
    since, until = (sent - offset for offset in TREND_WINDOW)
    earlier = demo_average(since, (until - since).total_seconds(), now)
    result['trends'] = {metric: round(result[metric] - earlier[metric], 2) for metric in METRICS}
    return jsonify(result)


@app.route('/api/demo/history')
def demo_history():
    range_key = request.args.get('range', '1h')
    if range_key not in RANGES:
        return bad_range_response()

    span, step = RANGES[range_key]
    now = datetime.now()
    points = []
    for bucket in range(to_epoch(now - span) // step, to_epoch(now) // step + 1):
        start = EPOCH + timedelta(seconds=bucket * step)
        points.append({'created_at': start.strftime(TIME_FORMAT),
                       **demo_average(start, step, now)})

    stats = {}
    for metric in METRICS:
        values = [point[metric] for point in points]
        stats[metric] = {'min': min(values), 'avg': round(sum(values) / len(values), 2),
                         'max': max(values)}
    return jsonify({'range': range_key, 'points': points, 'stats': stats})


# ---------- СТРАНИЦЫ ОШИБОК ----------
@app.errorhandler(404)
def not_found(_error):
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Такого адреса нет'}), 404
    return render_template('error.html', title='Страница не найдена',
                           text='Проверьте адрес или вернитесь на главную.'), 404


@app.errorhandler(500)
def server_error(_error):
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Ошибка на сервере'}), 500
    return render_template('error.html', title='Ошибка на сервере',
                           text='Обновите страницу. Подробности записаны в журнал сервера.'), 500


init_db()

# ---------- ЗАПУСК ----------
if __name__ == '__main__':
    # Режим отладки по умолчанию выключен: через него любой в сети мог бы выполнить код
    # на этом компьютере. Включить на время разработки: ECO_DEBUG=1
    app.run(host=os.environ.get('ECO_HOST', '0.0.0.0'),
            port=int(os.environ.get('ECO_PORT', '5000')),
            debug=os.environ.get('ECO_DEBUG') == '1')
