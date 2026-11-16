"""Проверки сайта. Запуск из папки проекта: python -m unittest discover tests"""
import csv
import io
import os
import re
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

# Проверки работают со временной базой и не трогают настоящую
_tmp = tempfile.TemporaryDirectory()
os.environ['ECO_DATABASE'] = str(Path(_tmp.name) / 'test.db')
os.environ['ECO_SECRET_KEY'] = 'test-key'
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import METRICS, RANGES, app, demo_reading, find_zone  # noqa: E402

GOOD = {'temperature': 22.5, 'humidity': 50, 'co2': 600, 'dust': 10}


class AppTestCase(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(app.config['DATABASE'])
        self.db.execute('DELETE FROM measurements')
        self.db.execute('DELETE FROM users')
        self.db.commit()
        app.config.update(API_KEY='', ALLOW_REGISTRATION=True)
        self.client = app.test_client()

    def tearDown(self):
        self.db.close()

    def token(self, path):
        html = self.client.get(path).get_data(as_text=True)
        return re.search(r'name="csrf_token" value="([^"]+)"', html).group(1)

    def sign_in(self):
        # Регистрация сразу впускает на сайт, отдельно входить не нужно
        response = self.client.post('/register', data={
            'csrf_token': self.token('/register'), 'username': 'tester',
            'password': 'secret1', 'password_confirm': 'secret1'})
        self.assertEqual(response.status_code, 302)

    def sign_out(self):
        self.client.post('/logout', data={'csrf_token': self.token('/')})

    def log_in(self, password='secret1', **extra):
        return self.client.post('/login', data={
            'csrf_token': self.token('/login'), 'username': 'tester',
            'password': password, **extra})

    def sees_dashboard(self):
        return 'id="dashboard"' in self.client.get('/').get_data(as_text=True)

    def rows(self):
        return self.db.execute(
            'SELECT temperature, humidity, co2, dust FROM measurements').fetchall()

    def insert(self, age, **values):
        moment = (datetime.now() - age).strftime('%Y-%m-%d %H:%M:%S')
        row = {**GOOD, **values}
        self.db.execute(
            'INSERT INTO measurements (temperature, humidity, co2, dust, created_at) '
            'VALUES (?, ?, ?, ?, ?)',
            (row['temperature'], row['humidity'], row['co2'], row['dust'], moment))
        self.db.commit()


class ReceiveDataTests(AppTestCase):
    def test_accepts_normal_reading(self):
        response = self.client.post('/api/data', json=GOOD)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {'status': 'ok'})
        self.assertEqual(self.rows(), [(22.5, 50, 600, 10)])

    def test_accepts_json_without_content_type(self):
        response = self.client.post('/api/data', data='{"co2": 700}')
        self.assertEqual(response.status_code, 200)

    def test_failed_sensor_keeps_other_values(self):
        response = self.client.post(
            '/api/data', data='{"temperature": NaN, "humidity": 50, "co2": 700, "dust": -5}',
            content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['rejected'], ['dust'])
        self.assertEqual(self.rows(), [(None, 50, 700, None)])

    def test_rejects_bad_bodies(self):
        for body in ('[1, 2]', 'not json', '{}', '{"co2": "abc"}', '{"co2": true}',
                     '{"co2": Infinity}'):
            with self.subTest(body=body):
                response = self.client.post('/api/data', data=body,
                                            content_type='application/json')
                self.assertEqual(response.status_code, 400)
                self.assertIn('error', response.get_json())
        self.assertEqual(self.rows(), [])

    def test_api_key(self):
        app.config['API_KEY'] = 'device-key'
        self.assertEqual(self.client.post('/api/data', json=GOOD).status_code, 401)
        wrong = self.client.post('/api/data', json=GOOD, headers={'X-API-Key': 'nope'})
        self.assertEqual(wrong.status_code, 401)
        right = self.client.post('/api/data', json=GOOD,
                                 headers={'X-API-Key': 'device-key'})
        self.assertEqual(right.status_code, 200)


class AuthTests(AppTestCase):
    def test_anonymous_access(self):
        # Гость видит страницу о проекте, но не показания
        landing = self.client.get('/')
        self.assertEqual(landing.status_code, 200)
        self.assertIn('Чистый воздух', landing.get_data(as_text=True))
        self.assertNotIn('id="dashboard"', landing.get_data(as_text=True))
        # Нормы на странице берутся из METRICS
        self.assertIn('норма 18–24 °C', landing.get_data(as_text=True))
        self.assertIn('норма до 800 ppm', landing.get_data(as_text=True))
        self.assertIn('href="/demo"', landing.get_data(as_text=True))
        for path in ('/api/latest', '/api/history'):
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.get('/export.csv').status_code, 302)

    def test_login_flow(self):
        self.sign_in()
        self.assertTrue(self.sees_dashboard())  # после регистрации человек уже внутри
        self.assertEqual(self.client.get('/logout').status_code, 405)
        self.sign_out()
        self.assertFalse(self.sees_dashboard())
        self.assertEqual(self.log_in().status_code, 302)
        self.assertTrue(self.sees_dashboard())

    def test_wrong_password(self):
        self.sign_in()
        self.sign_out()
        self.assertEqual(self.log_in(password='wrong-one').status_code, 200)
        self.assertFalse(self.sees_dashboard())

    def test_remember_me_is_optional(self):
        self.sign_in()
        self.sign_out()
        plain = self.log_in()
        self.assertNotIn('remember_token', ' '.join(plain.headers.getlist('Set-Cookie')))
        self.sign_out()
        remembered = self.log_in(remember='1')
        self.assertIn('remember_token', ' '.join(remembered.headers.getlist('Set-Cookie')))

    def test_about_page_for_everyone(self):
        self.assertIn('Чистый воздух', self.client.get('/about').get_data(as_text=True))
        self.sign_in()
        self.assertIn('href="/about"', self.client.get('/').get_data(as_text=True))
        about = self.client.get('/about').get_data(as_text=True)
        self.assertIn('Чистый воздух', about)
        self.assertNotIn('Создать аккаунт', about)  # вошедшему регистрация не нужна

    def test_post_without_csrf_is_ignored(self):
        self.client.post('/register', data={
            'username': 'hacker', 'password': 'secret1', 'password_confirm': 'secret1'})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 0)

    def test_password_mismatch(self):
        self.client.post('/register', data={
            'csrf_token': self.token('/register'), 'username': 'tester',
            'password': 'secret1', 'password_confirm': 'other12'})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 0)

    def test_registration_can_be_disabled(self):
        app.config['ALLOW_REGISTRATION'] = False
        self.assertEqual(self.client.get('/register').status_code, 302)
        self.assertNotIn('/register', self.client.get('/login').get_data(as_text=True))


class DashboardApiTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in()

    def test_latest_empty(self):
        self.assertEqual(self.client.get('/api/latest').get_json(), {})

    def test_latest_good(self):
        self.insert(timedelta(seconds=5))
        data = self.client.get('/api/latest').get_json()
        self.assertTrue(data['online'])
        self.assertEqual(data['summary']['level'], 'good')
        self.assertEqual(data['levels']['co2']['label'], 'Норма')

    def test_worst_value_decides_summary(self):
        self.insert(timedelta(seconds=5), co2=1500, humidity=65)
        summary = self.client.get('/api/latest').get_json()['summary']
        self.assertEqual(summary['level'], 'danger')
        self.assertEqual(summary['title'], 'Пора проветрить помещение')
        self.assertEqual(summary['advice'], ['Воздух влажный, стоит проветрить'])

    def test_missing_co2_is_not_reported_as_good(self):
        self.insert(timedelta(seconds=5), co2=None)
        self.assertNotIn('co2', self.client.get('/api/latest').get_json()['levels'])

    def test_old_reading_means_offline(self):
        self.insert(timedelta(hours=1))
        self.assertFalse(self.client.get('/api/latest').get_json()['online'])

    def test_trend_compares_with_quarter_hour_ago(self):
        self.insert(timedelta(minutes=16), co2=600, dust=None)
        self.insert(timedelta(minutes=14), co2=700, dust=None)
        self.insert(timedelta(minutes=2), co2=900)  # вне окна сравнения, не учитывается
        self.insert(timedelta(seconds=5), co2=1000, temperature=None)
        trends = self.client.get('/api/latest').get_json()['trends']
        self.assertEqual(trends['co2'], 350)
        self.assertNotIn('temperature', trends)  # сейчас значения нет
        self.assertNotIn('dust', trends)  # раньше значений не было

    def test_no_trend_without_earlier_readings(self):
        self.insert(timedelta(seconds=5))
        self.assertEqual(self.client.get('/api/latest').get_json()['trends'], {})

    def test_history_has_gaps_and_stats(self):
        self.insert(timedelta(minutes=30), co2=500)
        self.insert(timedelta(minutes=30), co2=700)
        self.insert(timedelta(days=2), co2=5000)
        data = self.client.get('/api/history?range=1h').get_json()
        self.assertGreaterEqual(len(data['points']), 60)
        filled = [p for p in data['points'] if p['co2'] is not None]
        self.assertLessEqual(len(filled), 2)
        self.assertEqual(data['stats']['co2'], {'min': 500, 'avg': 600, 'max': 700})

    def test_history_rejects_unknown_range(self):
        self.assertEqual(self.client.get('/api/history?range=x').status_code, 400)

    def test_every_range_works_without_data(self):
        for key in ('1h', '24h', '7d', '30d'):
            with self.subTest(key=key):
                data = self.client.get(f'/api/history?range={key}').get_json()
                self.assertEqual(data['stats'], {})
                self.assertLess(len(data['points']), 200)

    def test_csv_export(self):
        self.insert(timedelta(minutes=5), temperature=22.5, co2=None)
        self.insert(timedelta(days=3))
        response = self.client.get('/export.csv?range=24h')
        self.assertIn('attachment', response.headers['Content-Disposition'])
        text = response.get_data().decode('utf-8-sig')
        rows = list(csv.reader(io.StringIO(text), delimiter=';'))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][1:], ['22,5', '50,0', '', '10,0'])


class DemoTests(AppTestCase):
    """Демо открыто всем и показывает только придуманные показания."""

    def test_demo_page_is_public_and_marked(self):
        html = self.client.get('/demo').get_data(as_text=True)
        self.assertIn('id="dashboard"', html)
        self.assertIn('class="demo-banner', html)
        self.assertIn('/api/demo/latest', html)
        self.assertNotIn('"/api/latest"', html)

    def test_demo_latest_looks_like_real_answer(self):
        data = self.client.get('/api/demo/latest').get_json()
        self.assertTrue(data['online'])
        for metric, meta in METRICS.items():
            low, high = meta['allowed']
            self.assertTrue(low <= data[metric] <= high, metric)
        self.assertEqual(set(data['levels']), set(METRICS))
        self.assertEqual(set(data['trends']), set(METRICS))
        self.assertIn(data['summary']['level'], ('good', 'warn', 'danger'))

    def test_demo_history_every_range(self):
        for key in RANGES:
            with self.subTest(key=key):
                data = self.client.get(f'/api/demo/history?range={key}').get_json()
                self.assertEqual(data['range'], key)
                self.assertTrue(60 <= len(data['points']) < 200)
                self.assertTrue(all(point['co2'] is not None for point in data['points']))
                stats = data['stats']['co2']
                self.assertTrue(stats['min'] <= stats['avg'] <= stats['max'])
        self.assertEqual(self.client.get('/api/demo/history?range=x').status_code, 400)

    def test_demo_never_shows_real_measurements(self):
        self.insert(timedelta(seconds=5), co2=4321)
        self.assertNotEqual(self.client.get('/api/demo/latest').get_json()['co2'], 4321)
        self.assertEqual(self.client.get('/api/latest').status_code, 401)

    def test_demo_day_is_plausible(self):
        start = datetime(2026, 3, 2)
        day = [demo_reading(start + timedelta(minutes=minute)) for minute in range(0, 1440, 5)]
        self.assertEqual(day[7], demo_reading(start + timedelta(minutes=35)))  # без случайностей
        for metric, meta in METRICS.items():
            low, high = meta['scale']
            values = [reading[metric] for reading in day]
            self.assertTrue(low <= min(values) and max(values) <= high, metric)
        # За день воздух бывает и свежим, и душным: иначе демо ничего не покажет
        levels = {find_zone('co2', reading['co2'])['level'] for reading in day}
        self.assertTrue({'good', 'warn'} <= levels)


if __name__ == '__main__':
    unittest.main()
