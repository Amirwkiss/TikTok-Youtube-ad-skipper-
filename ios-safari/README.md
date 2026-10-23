# Safari на iPhone — экспериментальная версия

Эта папка содержит отдельное веб-расширение Safari для страниц `tiktok.com` и `youtube.com`. Оно ищет рекламу Musor Drop, Float Up и других названий в видимом тексте и субтитрах, перематывает на 4 секунды; размеченные спонсорские вставки YouTube получает через SponsorBlock.

Ограничения: расширение не работает внутри приложений TikTok и YouTube. На iPhone здесь пока нет распознавания речи из звука ролика. Если название рекламы только произнесено и не показано в тексте или субтитрах, оно может не сработать. Поведение на реальном iPhone ещё не проверено.

Для TestFlight нужен аккаунт Apple Developer. По [инструкции Apple](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect) можно создать запись приложения в App Store Connect и загрузить ZIP с содержимым этой папки в Safari Web Extension Packager. Затем собранное приложение распространяется через TestFlight. На iPhone после установки приложения расширение нужно включить в настройках Safari и разрешить доступ к TikTok и YouTube.
