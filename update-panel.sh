#!/bin/sh
# =============================================================================
# Скрипт обновления панели OlcRTC-OpenWRT / OpenWRT OlcRTC Panel
# Неинтерактивный: автоопределяет архитектуру и обновляет все компоненты.
# Используется страницей «Обновление» в LuCI и вручную по SSH:
#   /etc/olcrtc/update-panel.sh [-y]
# =============================================================================

set -e

REPO_RAW="https://raw.githubusercontent.com/skorp505/OlcRTC-OpenWRT/main"
BINARY_DST="/usr/bin/olcrtc"
INITD="/etc/init.d/olcrtc"
UCI_CONF="/etc/config/olcrtc"
LUCI_MENU="/usr/share/luci/menu.d/luci-app-olcrtc.json"
LUCI_ACL="/usr/share/rpcd/acl.d/luci-app-olcrtc.json"
LUCI_VIEW_DIR="/www/luci-static/resources/view/olcrtc"
LUCI_VIEW="${LUCI_VIEW_DIR}/main.js"
DATA_DIR="/etc/olcrtc/data"
PANEL_DIR="/etc/olcrtc"
PANEL_VERSION_FILE="${PANEL_DIR}/panel-version"
PANEL_UPDATE_SCRIPT="${PANEL_DIR}/update-panel.sh"
CHANGELOG_FILE="${PANEL_DIR}/CHANGELOG.md"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[ОК]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $*"; }

# Атомарное скачивание: во временный файл + mv. Перезаписывать
# напрямую запущенный бинарник нельзя (ETXTBSY "Text file busy").
# Без опции --tries: её нет в wget busybox многих прошивок («unrecognized
# option» = мгновенный отказ обновления). Ретраи делаем циклом.
dl() { # url dst; ошибка фатальна
    local n
    rm -f "$2.tmp"
    n=0
    while [ $n -lt 3 ]; do
        if wget -q --timeout=20 -O "$2.tmp" "$1" && [ -s "$2.tmp" ]; then
            mv -f "$2.tmp" "$2"
            return 0
        fi
        rm -f "$2.tmp"
        n=$((n + 1))
        [ $n -lt 3 ] && sleep 2
    done
    echo "[ОШ] не удалось скачать: $2"
    exit 1
}
dlw() { # url dst; ошибка не фатальна
    local n
    rm -f "$2.tmp"
    n=0
    while [ $n -lt 3 ]; do
        if wget -q --timeout=15 -O "$2.tmp" "$1" && [ -s "$2.tmp" ]; then
            mv -f "$2.tmp" "$2"
            return 0
        fi
        rm -f "$2.tmp"
        n=$((n + 1))
        [ $n -lt 3 ] && sleep 2
    done
    warn "не удалось обновить: $2"
    return 0
}

# Тихий режим для вызова из LuCI
if [ "${1:-}" = "-y" ]; then QUIET=1; else QUIET=0; fi

command -v wget >/dev/null 2>&1 || { echo "[ОШ] wget не найден"; exit 1; }

# ── Определяем архитектуру ─────────────────────────────────
case "$(uname -m)" in
    x86_64|amd64)
        ARCH="amd64"; BINARY_URL="${REPO_RAW}/olcrtc-linux-amd64" ;;
    aarch64|arm64)
        ARCH="arm64"; BINARY_URL="${REPO_RAW}/olcrtc-linux-arm64" ;;
    *)
        echo "[ОШ] Неподдерживаемая архитектура: $(uname -m)"; exit 1 ;;
esac

[ "$QUIET" = "1" ] || echo "Обновление OlcRTC-OpenWRT (${ARCH})..."

# ── Скачиваем бинарник olcrtc ──────────────────────────────
dl "$BINARY_URL" "$BINARY_DST"
chmod 755 "$BINARY_DST"
[ "$QUIET" = "1" ] || info "бинарник обновлён: $BINARY_DST"

# ── init.d ─────────────────────────────────────────────────
dl "${REPO_RAW}/files/etc/init.d/olcrtc" "$INITD"
chmod 755 "$INITD"
[ "$QUIET" = "1" ] || info "init.d обновлён"

# ── LuCI: меню / ACL / вид ─────────────────────────────────
mkdir -p "$(dirname "$LUCI_MENU")" "$(dirname "$LUCI_ACL")" "$LUCI_VIEW_DIR"
dl "${REPO_RAW}/files/usr/share/luci/menu.d/luci-app-olcrtc.json" "$LUCI_MENU"
dl "${REPO_RAW}/files/usr/share/rpcd/acl.d/luci-app-olcrtc.json" "$LUCI_ACL"
dl "${REPO_RAW}/files/www/luci-static/resources/view/olcrtc/main.js" "$LUCI_VIEW"
[ "$QUIET" = "1" ] || info "LuCI интерфейс обновлён"

# ── Data: names / surnames ─────────────────────────────────
mkdir -p "$DATA_DIR"
dlw "${REPO_RAW}/files/etc/olcrtc/data/names"    "$DATA_DIR/names"
dlw "${REPO_RAW}/files/etc/olcrtc/data/surnames" "$DATA_DIR/surnames"

# ── Файлы панели: версия / скрипт / changelog ──────────────
mkdir -p "$PANEL_DIR"
dl "${REPO_RAW}/panel-version" "$PANEL_VERSION_FILE"
dlw "${REPO_RAW}/update-panel.sh" "$PANEL_UPDATE_SCRIPT"
chmod 755 "$PANEL_UPDATE_SCRIPT" 2>/dev/null || true
dlw "${REPO_RAW}/CHANGELOG.md" "$CHANGELOG_FILE"

[ -s "$PANEL_VERSION_FILE" ] || { echo "[ОШ] файл версии пуст после скачивания"; exit 1; }

NEW_VERSION="$(cat "$PANEL_VERSION_FILE" 2>/dev/null || echo '?')"
[ "$QUIET" = "1" ] || echo "Обновление завершено. Версия: ${NEW_VERSION}"
echo "VERSION=$NEW_VERSION"

# Перезапуск сервисов — в фоне с задержкой, чтобы rpcd успел
# отправить ответ панели перед перезапуском (иначе RPC-сессия обрывается)
( sleep 2; /etc/init.d/rpcd restart; /etc/init.d/uhttpd restart ) &
exit 0
