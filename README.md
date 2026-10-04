# xKeenVlessSwitcher

Веб-панель для управления XKeen на роутерах с Entware. Текущая версия — **2.1.13**.

- Компактный список подключений: флаги, пинг, активация и фильтр LTE / обычные серверы.
- Импорт подписок VLESS и Hysteria2, обновление по расписанию, трафик и срок действия.
- Профили маршрутизации: весь трафик через VPN или российские ресурсы напрямую.
- Синхронизация доменных списков с проверкой версии источников.
- Авто-переключение на резервный сервер и возврат на основной.
- Резервное копирование и восстановление настроек.

![Подключения — v2.1.12](screenshot.png)

<details>
<summary>Другие экраны</summary>

### Подписки

![Информация о подписке](docs/subscriptions.png)

### Добавление подписки

![Импорт подписки](docs/import-subscription.png)

### Маршрутизация

![Профили маршрутизации](docs/routing.png)

### Авто-переключение

![Резервные подключения](docs/autofailover.png)

</details>

На скриншотах используются демонстрационные данные.

## Установка

Нужны Entware, установленный XKeen/Xray и Node.js 18+. Поддержка Hysteria2 зависит от сборки Xray.

Для приватного репозитория скачайте [install.sh](https://github.com/Jack13PythonLearn/xKeenVlessSwitcher/blob/main/install.sh), перенесите его на роутер и запустите в SSH-сессии Entware:

```sh
sh install.sh
```

Установщик запросит GitHub-токен с правом чтения репозитория. После установки откройте `http://IP-роутера:3000`. Панель предназначена для доверенной локальной сети.

## Источники доменов

- [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community/tree/master/data) — выбранные списки сервисов и их зависимости.
- [itdoginfo/allow-domains](https://github.com/itdoginfo/allow-domains/blob/main/Russia/outside-raw.lst) — российские ресурсы для прямого подключения.

Состав списков: [routing-sources.json](lib/routing-sources.json). Обновление — вручную или раз в неделю. Если версия источников не изменилась, панель сообщает об этом и не перезаписывает правила.

## Изменения и проверка

[История изменений](CHANGELOG.md). Автоматические тесты: `node --test` — 53 теста для версии 2.1.13.

Основано на [XKeenSwitcher](https://github.com/sergey1900/XKeenSwitcher). Лицензия флагов: [MIT](public/flags-LICENSE.txt).
