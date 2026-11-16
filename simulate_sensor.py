"""Имитация прибора: отправляет на сайт придуманные показания, когда ESP32 нет под рукой.

Показания записываются в базу как настоящие, поэтому запускайте сайт с отдельной базой
(см. раздел «Проверка без прибора» в README.md).
"""
import argparse
import json
import math
import random
import time
import urllib.error
import urllib.request


def make_reading(step):
    """CO2 постепенно растёт, а затем падает, как будто помещение проветрили."""
    cycle = step % 120
    co2 = 550 + cycle * 9 if cycle < 100 else 1450 - (cycle - 100) * 45
    return {
        'temperature': round(22.5 + math.sin(step / 40) + random.uniform(-0.1, 0.1), 1),
        'humidity': round(46 + 4 * math.sin(step / 60) + random.uniform(-0.5, 0.5), 1),
        'co2': round(co2 + random.uniform(-15, 15)),
        'dust': round(14 + 6 * abs(math.sin(step / 25)) + random.uniform(-2, 2), 1),
    }


def main():
    parser = argparse.ArgumentParser(description='Имитация прибора для Эко-Монитора')
    parser.add_argument('--url', default='http://127.0.0.1:5000/api/data')
    parser.add_argument('--interval', type=float, default=5, help='секунд между отправками')
    parser.add_argument('--api-key', default='', help='ключ прибора, если он задан на сайте')
    args = parser.parse_args()

    headers = {'Content-Type': 'application/json'}
    if args.api_key:
        headers['X-API-Key'] = args.api_key

    print(f'Отправляю тестовые показания на {args.url}. Остановить: Ctrl+C')
    step = 0
    try:
        while True:
            reading = make_reading(step)
            request = urllib.request.Request(args.url, json.dumps(reading).encode(), headers)
            try:
                with urllib.request.urlopen(request, timeout=5):
                    print(reading)
            except urllib.error.HTTPError as error:
                print(f'Сайт ответил ошибкой {error.code}: {error.read().decode()}')
            except urllib.error.URLError as error:
                print(f'Сайт недоступен: {error.reason}. Он запущен?')
            step += 1
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print('Остановлено.')


if __name__ == '__main__':
    main()
