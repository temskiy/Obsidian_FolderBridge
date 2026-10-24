# Folder Bridge

> **⚠️ Это модифицированная версия оригинального плагина Folder Bridge (v2.15.4).** Реализован дополнительный функционал для поддержки разрешения конфликтов на основе приоритетов маунтов, оптимизации производительности для сетевых хранилищ и двуязычного интерфейса (английский / русский).

---

## Международная локализация (i18n)

Интерфейс плагина поддерживает два языка: **английский** и **русский**.

- **Выбор языка** — Настройки → выпадающий список "Language" с тремя вариантами:
  - **Auto** (по умолчанию) — следует языку Obsidian / ОС (`navigator.language`). Русский, если язык браузера начинается с `ru`, иначе английский.
  - **English** — принудительно английский интерфейс независимо от настроек системы.
  - **Russian** — принудительно русский интерфейс независимо от настроек системы.
- Смена языка мгновенно обновляет страницу настроек, все модалки, уведомления и названия команд.
- Весь текст интерфейса использует ключи `i18n.t()`; английский язык используется как fallback для любых отсутствующих переводов.

---

## Расширенный функционал (v2.15.4+)

Эта модифицированная версия добавляет разрешение конфликтов на основе приоритетов, управление производительностью и поддержку двуязычного интерфейса поверх оригинального плагина v2.15.4.

### Система приоритетов маунтов

Когда файлы или папки с идентичными путями существуют как в локальном хранилище, так и в примонтированных папках (локальных, WebDAV, S3, SFTP), система приоритетов определяет, какая версия отображается:

- **Разрешение конфликтов на основе приоритета** — каждый маунт и само хранилище имеют настраиваемое число приоритета. При конфликте объектов с идентичными путями побеждает маунт с наибольшим приоритетом.
- **Приоритет хранилища** — настраивается в настройках (по умолчанию: 1000). Определяет приоритет хранилища относительно примонтированных папок.
- **Приоритет маунта** — настраивается для каждого маунта (по умолчанию: 1000). Устанавливается при создании или редактировании маунта.
- **Правило разрешения конфликтов** — когда приоритеты равны, выбирается между `folders-win` (приоритет папок) или `files-win` (приоритет файлов).
- **Алфавитный резервный вариант** — когда приоритеты и типы равны, победитель выбирается по алфавитному порядку реального пути.
- **Поведение фолбэка** — если файл с наивысшим приоритетом не существует в своём маунте, система пробует следующего кандидата по приоритету.

### Тумблер слияния маунтов

Для пользователей, которым не нужно разрешение конфликтов на основе приоритетов (особенно на медленных сетевых маунтах типа WebDAV или S3), доступен тумблер **Enable mount merging**:

- **Когда выключен** (по умолчанию) — все операции I/O делегируются напрямую оригинальному адаптеру без проверок приоритетов. Дополнительные сетевые запросы не выполняются. Маунты работают нормально, но без разрешения конфликтов.
- **Когда включен** — активно полное разрешение конфликтов на основе приоритетов. Файлы из хранилища и маунтов объединяются с разрешением по приоритету.
- **Преимущество производительности** — отключение слияния маунтов устраняет все накладные расходы от проверок приоритетов и логики фолбэка, улучшая отклик на медленных сетевых подключениях.

### Дополнительные функции

- **Тумблер отладочного логирования** — подробное логирование в консоль для устранения неполадок разрешения приоритетов (выключено по умолчанию).
- **Сортировка списка маунтов** — сортировка списка маунтов в настройках по имени (A→Z / Z→A) или приоритету (сначала наибольший / сначала наименьший).
- **Предупреждения о приоритетах** — визуальное предупреждение, когда несколько маунтов имеют одинаковый приоритет, предупреждая пользователей о потенциальной неоднозначности.
- **Отображение приоритета** — каждая строка маунта показывает `[Priority: N]` в своём описании.
- **Теги маунтов** — назначайте теги маунтам для группировки. Теги отображаются в строке маунта как `[Tags: #tag1, #tag2]`.
- **Подсветка файлов в файловом эксплорере** — цветовой код файлов в дереве файлов на основе их источника маунта. Файлы локального хранилища никогда не подсвечиваются. Для каждого маунта можно настроить свой цвет подсветки (8 пресетов + произвольный выбор через колорпикер).

### Подсветка файлов в файловом эксплорере

При включении файлы из примонтированных папок визуально выделяются в файловом эксплорере Obsidian цветными левыми рамками и лёгким фоном.

- **Глобальный тумблер** — Настройки → Расширенные возможности → "Enable file explorer highlighting" (выключено по умолчанию). Отключение останавливает всю подсветку независимо от настроек маунтов.
- **Цвет для каждого маунта** — У каждого маунта есть опция "Explorer highlight color" в секции **Additional settings**. Выберите один из 8 пресетов (Blue, Orange, Green, Red, Purple, Teal, Yellow) или нажмите на колорпикер рядом с выпадающим списком для выбора произвольного цвета. "None" использует стиль темы по умолчанию.
- **Файлы хранилища исключены** — Файлы, принадлежащие локальному хранилищу, никогда не подсвечиваются, даже если маунт перекрывает тот же виртуальный путь.
- **Учёт приоритетов** — Когда один и тот же файл существует и в хранилище, и в маунте, цвет подсветки соответствует тому источнику, который побеждает в разрешении конфликтов по приоритету (та же логика, что и при отображении файлов).
- **Визуальное оформление** — Подсвеченные файлы получают цветную левую рамку (3px) и лёгкий оттенок фона (8% выбранного цвета). При наведении оттенок фона увеличивается до 15%.

### Перемещение файлов и разрешение конфликтов

Folder Bridge теперь поддерживает копирование и перемещение файлов между хранилищем и примонтированными папками с полным разрешением конфликтов и предупреждениями о больших файлах.

- **Копировать в… / Переместить в…** — щёлкните правой кнопкой мыши на любом файле или папке в файловом эксплорере и выберите "Копировать в…" или "Переместить в…" в контекстном меню. Fuzzy-search picker показывает все доступные назначения (хранилище + активные маунты).
- **Сохранение полного пути** — при копировании или перемещении полный путь от корня хранилища сохраняется в назначении. Например: `"Хранилище 0/файл.pdf"` → `"_12/Хранилище 0/файл.pdf"`.
- **Рекурсивные операции** — папки и всё их содержимое копируются или перемещаются рекурсивно, включая вложенные подпапки.
- **Модальное окно разрешения конфликтов** — когда файл или папка с таким же именем уже существует в назначении, появляется диалог с вариантами:
  - **Перезаписать** — заменить существующий файл/папку
  - **Перезаписать все** — заменить все конфликтующие файлы/папки в операции
  - **Пропустить** — пропустить этот файл/папку и продолжить
  - **Пропустить все** — пропустить все оставшиеся конфликтующие файлы/папки
  - **Отменить** — отменить операцию
- **Хранилище по умолчанию для создания** — Настройки → "Хранилище по умолчанию для создания" позволяет выбрать, где создаются новые файлы, когда путь существует в нескольких источниках (хранилище или маунт). Варианты: "Локальное хранилище" или любой активный маунт.
- **Предупреждения о больших файлах** — каждый маунт может иметь порог (в КБ). При копировании или перемещении файлов, превышающих порог, в этот маунт, появляется диалог подтверждения с именем файла, размером, назначением и тремя опциями: Подтвердить, Отменить или Отключить предупреждения для этого маунта.
- **Удаление с учётом хранилища** — при перемещении файлов источник правильно удаляется из хранилища (а не из реального пути маунта), если файл физически существует в хранилище, предотвращая появление "осиротевших" файлов.

### Теги маунтов

Теги маунтов позволяют группировать и управлять несколькими маунтами одновременно через команды в палитре команд.

- **Назначение тегов** — задавайте теги при создании или редактировании маунта в секции **Additional settings** (сворачивающаяся панель). Теги вводятся через запятую, например: `work, backup, projects`.
- **Теги по умолчанию** — при создании нового маунта автоматически предлагаются два тега: `all` и метка маунта (если задана). Вы можете редактировать или удалять их. При редактировании существующего маунта теги должны редактироваться вручную.
- **Отображение тегов** — теги отображаются в списке маунтов в настройках как обычный текст: `[Tags: #work, #backup]`.
- **Команды тегов** — для каждого уникального тега, найденного среди всех маунтов, регистрируются две команды в палитре команд:
  - **`Mount #tag`** — включает все маунты с этим тегом.
  - **`Unmount #tag`** — отключает все маунты с этим тегом.
- **Динамическое управление командами** — команды автоматически добавляются при появлении нового тега на любом маунте и автоматически скрываются, когда тег больше не существует ни на одном маунте. Команды используют `checkCallback` для скрытия, когда не найдено ни одного маунта с тегом, поэтому ручная очистка не требуется.
- **Префикс команд** — команды тегов имеют префикс `#`, чтобы отличать их от команд для отдельных маунтов.

---

Расширяет возможности одиночного корня хранилища Obsidian, позволяя монтировать внешние папки как бесшовные, нативно выглядящие директории внутри вашего хранилища. Файлы остаются в своих оригинальных местах — без копирования, дублирования или создания символических ссылок.

---

## Полный список функций (v2.14.0)

Основные возможности текущего релиза:

- **Управляемый рабочий процесс TOC** для создаваемых через UI локальных и vault-маунтов
- **Исправление синхронизации удаления маунтов** — удалённые заметки из маунтов немедленно исчезают из Obsidian
- **Очистка для ревьюеров community-плагинов** в парсере TOC для удаления предупреждения о неужесточающем типе без изменения поведения во время выполнения
- **Локальная проверка текста UI** с текстовой проверкой, ориентированной на ревьюеров, и поддержкой pre-commit хука

### Основные возможности

- **Нулевое дублирование** — файлы всегда читаются и записываются из их реальных мест на диске или удалённом бэкенде
- **Рабочие пространства с несколькими корнями** — монтируйте столько папок, сколько хотите, в любом виртуальном пути внутри одного хранилища
- **Полная интеграция с Obsidian** — примонтированные файлы участвуют в файловом эксплорере, Quick Switcher, поиске, граф-смежных процессах индексации, встраиваниях и обычных командах хранилища
- **Рендеринг изображений и PDF** — встроенные изображения и PDF внутри примонтированных папок рендерятся корректно, включая файлы, обслуживаемые через data URI или локальный файловый сервер, когда обычная схема URL хранилища Obsidian дала бы сбой
- **Безопасный allowlist** — доступны только явно одобренные реальные пути; защищённые системные директории заблокированы
- **Режим dry-run** — логируйте операции записи без их выполнения при тестировании новой конфигурации

### Типы маунтов

- **Локальные папки** — монтируйте любую директорию из локальной файловой системы, внешнего диска, NAS-шары, UNC-пути или папки, экспонированной через WSL
- **WebDAV-маунты** — монтируйте папки из Nextcloud, ownCloud, Synology или любого generic WebDAV-сервера; учётные данные шифруются для каждого устройства на десктопе через системный keychain и падают до session memory на мобильном
- **S3-совместимые маунты** — монтируйте Amazon S3, Backblaze B2, MinIO, Cloudflare R2 и другие совместимые бакеты, с пресетами провайдеров и шифрованными секретами для каждого устройства на десктопе
- **SFTP-маунты** — монтируйте удалённые SSH-директории с аутентификацией по паролю или приватному ключу, постоянные переподключающиеся сессии, поддержка только на десктопе
- **Мост между хранилищами** — монтируйте контент из другого хранилища Obsidian; конфигурация другого хранилища и конфликтующие папки, такие как `.obsidian`, `.trash` и `.smart-connections`, автоматически игнорируются

### Управление маунтами

- **Редактирование маунтов на месте** — изменяйте виртуальный путь, реальный путь, метку, режим чтения-записи или настройки наблюдателя без удаления и повторного создания маунта
- **Перетаскивание для изменения порядка в настройках** — визуально переупорядочивайте маунты и сохраняйте порядок немедленно
- **Перетаскивание в файловом эксплорере** — перетащите корень маунта в новое место в дереве хранилища и обновите его виртуальный путь в реальном времени
- **Контекстное действие `Move mount to…`** — щёлкните правой кнопкой на корне маунта и выберите нового родителя из picker'а папок хранилища
- **Маунты только для чтения** — блокируйте записи через конкретный маунт, сохраняя контент полностью просматриваемым и searchable
- **Быстрые тумблеры только для чтения** — переключайте только для чтения из строки настроек или через назначаемые команды для одного маунта или всех маунтов
- **Конфигурационные файлы TOC** — загружайте внешние read-only TOC-файлы, привязывайте UI к управляемому writable TOC-файлу для локальных и vault-маунтов и создавайте этот управляемый файл напрямую из ваших текущих UI-маунтов

### Надёжность и разрешение конфликтов

- **Фоновый мониторинг здоровья** — активные маунты проверяются каждые 30 секунд на достижимость
- **Индикаторы в статус-баре** — статусный элемент отображает здоровье маунтов, включая состояние предупреждения о недостижимости и состояние полного восстановления
- **Переподключение в один клик** — UI разрешения конфликтов expose переподключения для маунтов, которые стали недоступны
- **Специфичное для WebDAV зондирование здоровья** — WebDAV-маунты проверяются через адаптер, а не через локальные предположения файловой системы
- **Повторное воспроизведение маунтов при запуске** — примонтированные папки injectруются во внутреннее дерево хранилища Obsidian без необходимости перезапуска

### Тонкая настройка наблюдателя для каждого маунта

- **Пользовательский debounce** — устанавливайте задержку debounce для каждого маунта, чтобы балансировать между отзывчивостью и churn от инструментов быстрого сохранения
- **Режим polling** — переключайте отдельные маунты на stat polling для сетевых шар или файловых систем без надёжных нативных событий watch
- **Интервал polling** — настраивайте частоту polling независимо для каждого маунта
- **Ограничение max-files** — ограничивайте размер сканирования при запуске для очень больших деревьев директорий
- **Подавление всех событий наблюдателя** — сохраняйте маунт видимым, предотвращая его внешние файловые события от trigger'а реакций Obsidian/плагина
- **Фильтр событий новых файлов** — опционально анонсируйте только Markdown-файлы при создании, уменьшая interference от плагинов переименования вложений
- **Фильтр типов видимых файлов** — expose все файлы, только Markdown или только PDF, сохраняя реальную структуру папок на диске intact

### Синхронизация и мульти-устройства

- **Пути маунтов, специфичные для устройства** — мапьте одну и ту же виртуальную папку на разные реальные пути на разных машинах
- **Override'и путей для каждого устройства** — override'йте реальный путь синхронизированного маунта локально, не изменяя конфигурацию другого устройства
- **Контроль foreign-маунтов** — выбирайте, доступны ли маунты, созданные на другом устройстве, на текущем
- **Совместимая с синхронизацией модель настроек** — определения маунтов могут синхронизироваться, пока реальные секреты остаются специфичными для устройства и расшифровываются только в системном keychain десктопной ОС происхождения

### Система игнорирования

- **Browse-to-ignore** — выберите подпапку из OS folder picker и автоматически сохраните её mount-relative путь
- **Path-relative ignore-паттерны** — записи, содержащие `/`, игнорируют конкретное поддерево, не влияя на папки с аналогичными именами в других местах
- **Name-паттерны** — plain-записи, такие как `.git` или `node_modules`, совпадают с любым листом с этим именем
- **Glob-паттерны** — wildcard-записи, такие как `*.tmp` и `~$*`, совпадают с именами листов как globs
- **Context-menu ignore** — щёлкните правой кнопкой на любом файле или папке внутри маунта и мгновенно добавьте в список игнорирования
- **Глобальные ignore-правила** — применяйте общий ignore-базисный уровень через каждый маунт

### Платформа и производительность

- **Windows hardened** — длинные пути, UNC/сетевые пути, рабочие процессы типа OneDrive, зарезервированные имена и case-insensitive сравнения обрабатываются явно
- **Поддержка Linux и macOS** — POSIX-пути работают нативно, и одна и та же логика core-адаптера и наблюдателя применяется через десктопные платформы
- **Поддержка Android для удалённых маунтов** — WebDAV и S3-совместимые маунты работают на Android с mobile-adapted UI
- **Фоновый файловый наблюдатель** — изменения файлов из примонтированных папок появляются в Obsidian в реальном времени, когда бэкенд поддерживает это
- **Оптимизация кэша PathMapper** — активные маунты pre-normalised и сортируются один раз, так что разрешение путей остаётся быстрым даже со многими маунтами

### Поддержка платформ

Краткое сводка совместимости. Для специфичных для платформы caveat и заметок по настройке см. [Platform Notes](#platform-notes) ниже.

| Платформа | Статус | Примечания |
|----------|--------|-------|
| Windows | ✅ Протестировано | Полная поддержка — длинные пути, UNC, причуды NTFS все обработаны |
| macOS | ⚠️ Не протестировано | POSIX code-пути реализованы; пока официально не протестировано. Сообщества отчёты приветствуются. |
| Linux | ✅ Протестировано | POSIX-пути, работает включая WSL |
| Android | ✅ Стабильный | WebDAV и S3/B2-маунты работают полностью. UI auto-adapts, чтобы показывать только mobile-совместимые типы маунтов. См. [Android Setup Guide](docs/ANDROID_SETUP.md) |
| iOS | ❌ Не поддерживается | Пока не протестировано на iOS; WebDAV может работать теоретически |

---

## Установка

Folder Bridge в настоящее время не listed в каталоге Community Plugins Obsidian. Используйте BRAT или ручную установку ниже, пока community submission не одобрен.

### Использование BRAT (Beta Reviewers Auto-update Tool)

Установите последний published GitHub release через [BRAT](https://tfthacker.com/BRAT):

1. Установите плагин **Obsidian42 - BRAT** из каталога Community Plugins.
2. Включите BRAT в ваших настройках.
3. Откройте command palette и запустите **BRAT: Add a beta plugin for testing**.
4. Введите URL репозитория: `https://github.com/tescolopio/Obsidian_FolderBridge`
5. Нажмите **Add Plugin**. BRAT автоматически скачает и установит последний release.

### Ручная установка

1. Скачайте `main.js`, `manifest.json` и `styles.css` с [последнего release](https://github.com/tescolopio/Obsidian_FolderBridge/releases/latest)
2. Скопируйте их в `<ваше-хранилище>/.obsidian/plugins/folderbridge/`
3. Включите плагин в **Settings → Community Plugins**

### Локальная разработка (git clone)

Если вы хотите запустить прямо из source (без скачивания release):

```bash
# 1. Clone в папку плагинов вашего хранилища
git clone https://github.com/tescolopio/Obsidian_FolderBridge.git \
  /path/to/your-vault/.obsidian/plugins/folderbridge

cd /path/to/your-vault/.obsidian/plugins/folderbridge

# 2. Установите зависимости
npm install

# 3. Соберите плагин (produces main.js, который загружает Obsidian)
npm run build
```

Затем в Obsidian: **Settings → Community Plugins → disable Safe Mode → enable Folder Bridge**.

> **Hot-reload во время разработки:** запустите `npm run dev` вместо `npm run build`.
> Установите [hot-reload plugin](https://github.com/pjeby/hot-reload) в Obsidian, и он будет
> автоматически reload Folder Bridge whenever `main.js` rebuilt.

---

## Быстрый старт

1. Нажмите на ribbon-иконку **folder-plus** (или перейдите в **Settings → Folder Bridge → Add Mount Point**)
2. Выберите **Mount Type** (Local folder, WebDAV, S3/Backblaze B2, SFTP или Another Obsidian vault)
3. Заполните **Real path** и **Virtual path**, затем нажмите **Validate & Add**

Папка немедленно появляется в файловом эксплорере Obsidian — перезапуск не нужен.

Для полных step-by-step instructions на каждый тип маунта и функцию, см. [Usage Guide](#usage-guide) ниже.

Для advanced JSON-driven mount definitions, см. [TOC Config Guide](docs/TOC_CONFIG.md).

Если вы хотите, чтобы Settings UI записывала локальные и vault-маунты в JSON-файл вместо только `data.json`, используйте managed TOC workflow, описанный ниже.

---

## Владение маунтами и рабочий процесс TOC

Folder Bridge теперь treats mount storage как source-of-truth decision, а не просто option формата файла.

Есть три режима владения маунтами:

- **Manual / `data.json` маунты** — default behavior, когда no managed TOC file configured.
- **Managed TOC маунты** — local и vault маунты, записываемые Settings UI в один writable JSON-файл.
- **External TOC маунты** — additional JSON-файлы, которые Folder Bridge reads при runtime, но не edit из UI.

Как это работает на практике:

- Если вы ничего не делаете, маунты продолжают работать по-старому и остаются в `data.json`.
- Если вы configured **Managed TOC file**, new local и vault маунты, созданные из Settings, записываются туда вместо.
- Если у вас уже есть working local/vault setup в Settings, используйте **Create from current UI mounts** once, чтобы создать файл и migrate те маунты автоматически.
- Если вы добавите **External TOC config files**, те маунты появляются в Settings, но остаются read-only, потому что их source file authoritative.
- WebDAV, S3 и SFTP маунты остаются в `data.json`, потому что TOC-файлы не store credentials.

Это affects весь плагин, не только TOC screens:

- Editable маунты включают manual маунты и managed-TOC маунты.
- Read-only external TOC маунты locked consistently в row actions, ignore-list editing, toggle flows, и command-palette actions.
- Import/export covers маунты, которыми вы всё ещё можете manage из UI.

Recommended setup:

1. Используйте **Managed TOC file**, если вы хотите один editable JSON source для local и vault маунтов.
2. Используйте **Create from current UI mounts** первый раз, если ваш setup уже exists в Settings.
3. Используйте **External TOC config files** для shared, reviewed, или machine-specific read-only mount definitions.
4. Оставьте credentialed cloud маунты в `data.json`.

Для JSON schema, examples, и troubleshooting details, см. [TOC Config Guide](docs/TOC_CONFIG.md).

---

## Поддержка и follow

Если Folder Bridge полезен в вашем workflow, вы можете support проект в lightweight ways:

- Follow other work on [GitHub](https://github.com/tescolopio)
- Browse или star [Folder Bridge repository](https://github.com/tescolopio/Obsidian_FolderBridge)

Plugin settings также include direct GitHub buttons под **Support Folder Bridge**.

---

## Руководство по использованию

### Добавление локального маунта

1. Нажмите на ribbon-иконку **folder-plus** или перейдите в **Settings → Folder Bridge** и нажмите **Add Mount Point**
2. В dropdown **Mount Type** выберите **Local folder**
3. **Real path** — нажмите **Browse…** для открытия OS folder picker или введите absolute path  
   - Windows: `C:\Users\YourName\Documents\Work`  
   - Linux / macOS: `/home/yourname/Documents/Work`  
   - WSL path из Windows: `\\wsl.localhost\Ubuntu\home\yourname\Work`  
   - UNC network path: `\\server\share\documents`
4. **Virtual path** — где папка появится внутри вашего хранилища, например `Projects/Work`  
   - Нажмите **Browse vault…** для выбора existing vault folder как parent  
   - Оставьте empty, чтобы mount при vault root, используя real folder's name
5. Опционально установите **Label** для маунта (показывается в settings list)
6. Опционально включите **Read-only**, чтобы block all writes через этот маунт
7. Нажмите **Validate & Add**

Папка немедленно появляется в файловом эксплорере Obsidian. Перезапуск не нужен.

---

### Добавление WebDAV-маунта

Монтируйте remote Nextcloud, ownCloud или generic WebDAV server как vault folder.

1. Нажмите **Add Mount Point** и выберите **WebDAV server** в dropdown **Mount Type**
2. **Server URL** — полный URL к вашему WebDAV server, например:
   - Nextcloud: `https://cloud.example.com/remote.php/dav/files/username`
   - Generic: `https://dav.example.com`
3. **Remote path** — path на server для mount, например `/Documents/Notes`
4. **Virtual path** — где это появится в вашем хранилище, например `Remote/Notes`
5. **Username** — ваш WebDAV username
6. **Password** — ваш WebDAV password  
   > 🔒 Password зашифрован вашим **OS keychain** (Windows DPAPI / macOS Keychain / Linux libsecret) и stored в `data.json`. Он persists across Obsidian restarts — no re-entry needed. Encrypted blob device-specific; other devices cannot decrypt it даже если `data.json` syncs. На mobile passwords fall back до session memory only.
7. Нажмите **Validate & Add**

Folder Bridge will test the connection before saving. Если server unreachable, вы увидите error с reason.

---

### Мост между хранилищами (Vault-to-Vault Bridging)

Просматривайте папку из второго Obsidian vault внутри вашего текущего без дублирования файлов.

1. Нажмите **Add Mount Point** и выберите **Another Obsidian vault** в dropdown **Mount Type**
2. **Real path** — нажмите **Browse…** и перейдите к **root folder** другого vault (папка, которая содержит `.obsidian` directory)
3. Опционально сузьте до **sub-folder** этого vault, указав relative path внутри него
4. Установите **Virtual path**, где это появится в вашем текущем хранилище, например `Reference`
5. Нажмите **Validate & Add**

Folder Bridge автоматически добавляет `.obsidian`, `.trash` и `.smart-connections` в ignore list для vault маунтов, чтобы предотвратить interference двух хранилищ друг с другом.

---

### Редактирование существующего маунта

Все настройки маунта могут быть изменены без удаления и повторного добавления маунта.

1. Откройте **Settings → Folder Bridge**
2. Нажмите кнопку **Edit** (карандаш) на любой mount row
3. Измените любое поле — virtual path, real path, label, read-only flag, или watcher settings
4. Нажмите **Save**

Vault tree, file watcher, и все internal caches обновляются live. Перезапуск не нужен.

---

### Изменение порядка маунтов

Порядок маунтов в списке определяет порядок, в котором они проверяются при resolution paths.

- **Drag** mount row up или down в **Settings → Folder Bridge** для изменения порядка
- Новый order сохраняется immediately

---

### Перемещение маунта в файловом эксплорере

Вы можете изменить virtual path маунта напрямую из Obsidian's file explorer без открытия Settings.

**Option 1 — Drag and drop:**
1. В file explorer, click и hold mounted folder
2. Drag его в новое место в vault hierarchy
3. Virtual path обновляется live — ничего на disk не трогается

**Option 2 — Context menu:**
1. Right-click mounted folder root в file explorer
2. Выберите **Move mount to…**
3. Выберите новый parent folder из vault picker
4. Нажмите **Move**

---

### Маунты только для чтения (Read-Only Mounts)

Предотвратите any write operations через конкретный маунт (useful для reference folders или shared network drives, которыми вы не владеете).

- Включите тумблер **Read-only** при добавлении или редактировании маунта, или нажмите на **lock icon** напрямую на любой mount row в Settings
- Lock icon становится amber, когда маунт read-only, так что вы можете видеть его state at a glance без открытия edit modal
- Toggle all маунты одновременно с помощью команды **Folder Bridge: Toggle read-only on all mounts** (assignable к hotkey)
- Toggle одного маунта по name с помощью команды **Folder Bridge: Toggle read-only on a specific mount…** (assignable к hotkey)
- Obsidian всё ещё может open, search, и read all files в маунте
- Любая attempt создать, edit, rename, или delete file через маунт silently blocked с one-time Notice

---

### Список игнорирования (Ignore List)

Скройте specific files или folders внутри маунта от Obsidian. Useful для large directories (`node_modules`, build outputs), которые замедляли бы indexing.

**Добавление entries manually:**
1. Откройте **Settings → Folder Bridge**, expand mount, и перейдите к section **Ignore List**
2. Введите pattern и нажмите **Add**

**Добавление entries с folder picker (Browse…):**
1. Нажмите кнопку **Browse…** рядом с ignore list input
2. OS folder picker открывается внутри real directory маунта
3. Перейдите к subfolder, который хотите игнорировать, и нажмите **OK**
4. Mount-relative path fill в automatically — review и нажмите **Add**

**Добавление entries из file explorer:**
1. Right-click любой file или folder внутри mounted directory
2. Выберите **Ignore in Folder Bridge**
3. Entry добавляется immediately, и item disappears из file explorer

**Pattern types:**

| Pattern | Behaviour | Example |
|---------|-----------|---------|
| Plain name | Совпадает с любым file или folder с этим leaf name anywhere в маунте | `node_modules` |
| Path prefix (contains `/`) | Совпадает только с этим exact subtree | `assets/vendor/plantuml-stdlib` |
| Glob (contains `*`) | Совпадает с именами листов против glob | `*.tmp`, `~$*`, `build*` |

---

### Разрешение конфликтов и мониторинг здоровья (Conflict Resolution & Health Monitoring)

Folder Bridge проверяет каждый active mount на reachability каждые **30 секунд** в background.

**Когда маунт goes offline** (drive disconnected, network drop, WebDAV server unreachable):
- An **orange indicator** появляется в Obsidian status bar
- Нажмите на indicator для открытия **Conflict Resolution panel**
- Panel показывает каждый affected mount с его last-known error
- Нажмите **Reconnect** рядом с mount для retry его immediately

**Когда все маунты reachable:**
- Status bar indicator становится **green** (если visible) или disappears, depending на ваши settings

---

### Тонкая настройка наблюдателя для каждого маунта (Per-Mount Watcher Tuning)

Каждый маунт имеет independent file-watcher settings. Откройте **Edit** на любом mount для просмотра:

| Setting | Default | Description |
|---------|---------|-------------|
| **Debounce (ms)** | 300 | How long to wait after last file-change event before notifying Obsidian. Lower = more responsive; higher = less CPU на rapid saves. |
| **Use polling** | Off | Enable stat-based polling вместо native OS watch events. Required для большинства network drives и некоторых containerised filesystems. |
| **Polling interval (ms)** | 2000 | How frequently to poll когда polling mode on. Has no effect когда polling off. |
| **Visible file types** | All | Limit что Obsidian видит из этого маунта: all files, только Markdown, или только PDF. |
| **Max files** | 10 000 | Stop scanning directory tree после этого many entries. Protects performance на very large mounts. |

> **Tip:** Для local SSD, leave all defaults. Для Samba/NFS network share, enable **Use polling** и установите interval до 3000–5000 ms, чтобы избежать hammering server.

---

### Пути, специфичные для устройств (Device-Specific Paths / Multi-Device Sync)

Каждый маунт tagged с `deviceId` машины, которая его created. Когда ваш vault syncs к другому device, Obsidian этого device увидит mount, но не activate его, unless path также exists там.

**Для маппинга mount к different path на другом device:**

1. На втором device, откройте **Settings → Folder Bridge**
2. Найдите mount (он покажет warning badge, если original path не exists locally)
3. Нажмите **Override Path** и введите correct local path для этого device
4. Нажмите **Save**

Override applies только к этому device; original path preserved для device, которое его created.

**Для того, чтобы все маунты от других devices activate automatically (если paths match):**
- Включите **Allow foreign mounts** в **Settings → Folder Bridge**

---

## Справочник настроек (Settings Reference)

| Setting | Description |
|---------|-------------|
| **Dry-run mode** | Log all write operations к console без их executing. Safe для testing configuration changes. |
| **Show status bar item** | Display active mount count (и health indicator) в Obsidian's status bar. |
| **Allow foreign mounts** | Activate маунты, созданные на других устройствах, если real path exists на этой машине. |
| **Mount list** | Enable, disable, edit, или remove individual маунты. Каждая row показывает live reachability badge и drag handle. |

---

## Заметки по платформе (Platform Notes)

### Windows

- **Long paths**: Paths over 260 characters handled automatically с `\\?\` prefix. Для best results, также enable **Long Path Support** в Windows Settings → System → For Developers.
- **Symlinks**: Creating symlinks на Windows требует либо Developer Mode, либо administrator rights. Folder Bridge сам не creates symlinks, но underlying filesystem может encounter related permission errors.
- **UNC network paths** (`\\server\share\...`): Supported, но file-change watching может не работать на некоторых servers и path может быть unavailable offline.
- **Reserved names**: Files и folders named `CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (Windows reserved device names) blocked от creation через Folder Bridge для предотвращения cryptic OS errors.
- **OneDrive Files On Demand**: Online-only placeholder files will show user-friendly error вместо raw ENOENT. Right-click file в Explorer и выберите **Always keep on this device** для make его locally accessible.

### macOS

> ⚠️ **macOS пока не был официально протестирован.** POSIX code-пути fully implemented и должны работать, но могут быть edge cases. Если вы столкнётесь с issues, пожалуйста [open an issue](https://github.com/tescolopio/Obsidian_FolderBridge/issues) — macOS bug reports активно welcomed.

- Standard absolute paths работают: `/Users/yourname/Documents/Work`
- **iCloud Drive (optimized storage)**: Files set к "online only" behave как OneDrive placeholders — Folder Bridge will surface friendly error. Open Finder, right-click file, и выберите **Download Now** для make его available locally.

### Mobile (iOS / Android)

**Android** — WebDAV и S3/B2 маунты fully supported на Obsidian для Android (v2.0.0+). Connect к Nextcloud, ownCloud, NAS, любой WebDAV server, или S3-compatible bucket с вашего phone — no extra apps required. Local и SFTP маунты не available на Android из-за app sandbox. См. [Android Setup Guide](docs/ANDROID_SETUP.md) для step-by-step instructions.

**iOS** — Пока не tested. WebDAV может работать теоретически (same code paths как Android) но не officially supported. Feedback welcome via [GitHub Issues](https://github.com/tescolopio/Obsidian_FolderBridge/issues).

---

## Архитектура

Folder Bridge устанавливает lightweight **virtual filesystem adapter shim**, который intercepts every I/O call Obsidian делает к его vault:

```
Obsidian → vault.adapter (Proxy) → VirtualAdapter
                                         ├── path inside a mount? → Node.js fs APIs (real path)
                                         └── path outside mounts? → original FileSystemAdapter
```

JavaScript `Proxy` forwards все undocumented Obsidian-internal methods transparently к original adapter, так что ни одна Obsidian functionality не broken.

---

## Настройка разработки (Development Setup)

### Требования

- Node.js 20.x (LTS)
- npm

### Установка

```bash
git clone https://github.com/tescolopio/Obsidian_FolderBridge.git
cd Obsidian_FolderBridge
npm install
```

### Linking к вашему vault

```bash
# Windows (PowerShell, run как administrator или с Developer Mode enabled)
New-Item -ItemType Junction -Path "$env:APPDATA\obsidian\<YourVault>\.obsidian\plugins\folderbridge" -Target (Get-Location)

# Linux / macOS
ln -s "$(pwd)" "/path/to/vault/.obsidian/plugins/folderbridge"
```

### Build scripts

```bash
npm run dev      # Watch mode с hot-reload
npm run build    # Production build (type-checks first)
npm test         # Run unit tests
npm run version  # Bump version в manifest.json и versions.json
```

### Структура проекта

```
├── main.ts                    # Точка входа плагина и UI настроек
├── src/
│   ├── types.ts               # Общие TypeScript интерфейсы
│   ├── PathMapper.ts          # Преобразование виртуальных ↔ реальных путей
│   ├── VirtualAdapter.ts      # Виртуальный файловый адаптер (ядро)
│   ├── SecurityManager.ts     # Enforcement allowlist и валидация
│   ├── OSHelpers.ts           # Определение платформы и помощники Windows
│   ├── CredentialStore.ts     # Шифрование учётных данных OS-keychain (Electron safeStorage)
│   ├── FileWatcher.ts         # chokidar-based фоновый файловый наблюдатель
│   ├── FileTransfer.ts        # Расчёт размера файлов и разрешение назначения
│   ├── mountFileFilter.ts     # Фильтры видимости типов файлов
│   └── ui/
│       ├── MountManagerModal.ts       # Диалог добавления/редактирования маунта
│       ├── DestinationPickerModal.ts  # Picker назначения для копирования/перемещения
│       ├── LargeFileWarningModal.ts   # Подтверждение передачи больших файлов
│       └── ConflictResolutionModal.ts # Диалог разрешения конфликтов
├── tests/                     # Юнит-тесты Vitest
├── manifest.json              # Метаданные плагина
├── versions.json              # Карта Version → minAppVersion
└── esbuild.config.mjs         # Конфигурация сборки
```

---

## Вклад (Contributing)

Contributions welcome! Пожалуйста, откройте issue или pull request.

См. [CONTRIBUTING.md](CONTRIBUTING.md) для guidelines.

---

## License

MIT — см. [LICENSE](LICENSE) для details.

## Attribution

Этот plugin не использует code от других Obsidian plugins. Он relies solely на official Obsidian API и standard Node.js libraries.