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
wget -q -O "$BINARY_DST" "$BINARY_URL" || { echo "[ОШ] не удалось скачать бинарник"; exit 1; }
chmod 755 "$BINARY_DST"
[ "$QUIET" = "1" ] || info "бинарник обновлён: $BINARY_DST"

# ── init.d ─────────────────────────────────────────────────
wget -q -O "$INITD" "${REPO_RAW}/files/etc/init.d/olcrtc" || { echo "[ОШ] init.d"; exit 1; }
chmod 755 "$INITD"
[ "$QUIET" = "1" ] || info "init.d обновлён"

# ── LuCI: меню / ACL / вид ─────────────────────────────────
mkdir -p "$(dirname "$LUCI_MENU")" "$(dirname "$LUCI_ACL")" "$LUCI_VIEW_DIR"
wget -q -O "$LUCI_MENU" "${REPO_RAW}/files/usr/share/luci/menu.d/luci-app-olcrtc.json" || { echo "[ОШ] меню"; exit 1; }
wget -q -O "$LUCI_ACL" "${REPO_RAW}/files/usr/share/rpcd/acl.d/luci-app-olcrtc.json" || { echo "[ОШ] acl"; exit 1; }
wget -q -O "$LUCI_VIEW" "${REPO_RAW}/files/www/luci-static/resources/view/olcrtc/main.js" || { echo "[ОШ] main.js"; exit 1; }
[ "$QUIET" = "1" ] || info "LuCI интерфейс обновлён"

# ── Data: names / surnames ─────────────────────────────────
mkdir -p "$DATA_DIR"
wget -q -O "$DATA_DIR/names"    "${REPO_RAW}/files/etc/olcrtc/data/names"    || warn "data/names не обновлён"
wget -q -O "$DATA_DIR/surnames" "${REPO_RAW}/files/etc/olcrtc/data/surnames" || warn "data/surnames не обновлён"

# ── Файлы панели: версия / скрипт / changelog ──────────────
mkdir -p "$PANEL_DIR"
wget -q -O "$PANEL_VERSION_FILE" "${REPO_RAW}/panel-version" || warn "не удалось обновить версию"
wget -q -O "$PANEL_UPDATE_SCRIPT" "${REPO_RAW}/update-panel.sh" || warn "не удалось обновить скрипт обновления"
chmod 755 "$PANEL_UPDATE_SCRIPT" 2>/dev/null || true
wget -q -O "$CHANGELOG_FILE" "${REPO_RAW}/CHANGELOG.md" || warn "не удалось обновить CHANGELOG"

# ── Перезапуск сервисов ────────────────────────────────────
/etc/init.d/rpcd   restart 2>/dev/null || warn "rpcd не перезапущен"
/etc/init.d/uhttpd restart 2>/dev/null || warn "uhttpd не перезапущен"

NEW_VERSION="$(cat "$PANEL_VERSION_FILE" 2>/dev/null || echo '?')"
[ "$QUIET" = "1" ] || echo "Обновление завершено. Версия: ${NEW_VERSION}"
echo "VERSION=$NEW_VERSION"
exit 0
