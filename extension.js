/*
 * Claude Meter — GNOME Shell extension showing Claude usage.
 * Copyright (C) 2026 jairhdez
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {UsageClient, readAccountInfo} from './client.js';

const REFRESH_SECONDS = 300;
const USAGE_PAGE_URL = 'https://claude.ai/settings/usage';

function pickColorClass(pct) {
    if (pct >= 90) return 'claude-meter-red';
    if (pct >= 80) return 'claude-meter-orange';
    if (pct >= 60) return 'claude-meter-yellow';
    return 'claude-meter-normal';
}

// The API returns a tree of usage windows. We pick the highest percentage among
// the windows the user actually has data for; that's what defines "how close am I
// to hitting a wall right now". Adjust extractWindows() if the schema changes.
function extractWindows(json) {
    const out = [];
    const fivehour = json?.five_hour ?? json?.fiveHour;
    const week = json?.seven_day ?? json?.week ?? json?.sevenDay;
    if (fivehour && typeof fivehour.utilization === 'number')
        out.push({label: '5h', pct: fivehour.utilization, resets_at: fivehour.resets_at});
    if (week && typeof week.utilization === 'number') {
        const breakdown = [];
        const sonnet = json?.seven_day_sonnet;
        const opus = json?.seven_day_opus;
        if (sonnet && typeof sonnet.utilization === 'number' && sonnet.utilization > 0)
            breakdown.push({label: 'Sonnet', pct: sonnet.utilization});
        if (opus && typeof opus.utilization === 'number' && opus.utilization > 0)
            breakdown.push({label: 'Opus', pct: opus.utilization});
        out.push({label: 'week', pct: week.utilization, resets_at: week.resets_at, breakdown});
    }
    return out;
}

function bar(pct, width = 12) {
    const clamped = Math.min(100, Math.max(0, pct));
    const filled = Math.round((clamped / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatAbsoluteTime(date) {
    return date.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
}

function formatResetTime(isoString) {
    if (!isoString) return '';
    const reset = new Date(isoString);
    if (isNaN(reset.getTime())) return '';
    const deltaMs = reset.getTime() - Date.now();
    if (deltaMs <= 0) return 'resets now';

    const totalMin = Math.floor(deltaMs / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;

    let rel;
    if (days > 0) rel = `${days}d ${hours}h`;
    else if (hours > 0) rel = `${hours}h ${mins}m`;
    else rel = `${mins}m`;

    const sameDay = reset.toDateString() === new Date().toDateString();
    const local = sameDay
        ? reset.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})
        : reset.toLocaleString(undefined, {weekday: 'short', hour: 'numeric', minute: '2-digit'});

    return `resets in ${rel} (${local})`;
}

const ClaudeMeterIndicator = GObject.registerClass(
    class ClaudeMeterIndicator extends PanelMenu.Button {
        _init(extensionPath) {
            super._init(0.5, 'Claude Meter');

            this._client = new UsageClient();
            this._lastWindows = [];

            const box = new St.BoxLayout({style_class: 'claude-meter-box'});
            const iconFile = Gio.File.new_for_path(`${extensionPath}/icons/claude-symbolic.svg`);
            this._icon = new St.Icon({
                gicon: new Gio.FileIcon({file: iconFile}),
                style_class: 'system-status-icon claude-meter-icon',
            });
            this._label = new St.Label({
                text: '—',
                y_align: 2, // CENTER
                style_class: 'claude-meter-label',
            });
            box.add_child(this._icon);
            box.add_child(this._label);
            this.add_child(box);

            this._windowsSection = new PopupMenu.PopupMenuSection();
            this._statusItem = new PopupMenu.PopupMenuItem('Loading…', {reactive: false});
            this._windowsSection.addMenuItem(this._statusItem);
            this.menu.addMenuItem(this._windowsSection);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
            refreshItem.connect('activate', () => this._refresh());
            this.menu.addMenuItem(refreshItem);

            const openItem = new PopupMenu.PopupMenuItem('Open claude.ai/settings/usage');
            openItem.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri(USAGE_PAGE_URL, null);
            });
            this.menu.addMenuItem(openItem);

            this._refresh();
            this._timer = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                    this._refresh();
                    return GLib.SOURCE_CONTINUE;
                },
            );
        }

        _refresh() {
            this._client.fetchUsage((json, err) => {
                if (err) {
                    this._showError(err);
                    return;
                }
                this._render(json);
            });
        }

        _showError(err) {
            this._label.text = '!';
            this._setColorClass('claude-meter-red');
            this._setSimpleStatus(`Error: ${err.message}`);
        }

        _setSimpleStatus(text) {
            this._windowsSection.removeAll();
            const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
            this._windowsSection.addMenuItem(item);
        }

        _render(json) {
            const windows = extractWindows(json);
            this._lastWindows = windows;
            this._lastRefresh = new Date();

            if (windows.length === 0) {
                this._label.text = '?';
                this._setColorClass('claude-meter-normal');
                this._setSimpleStatus('No usage data in response');
                return;
            }

            const max = windows.reduce((a, b) => (a.pct >= b.pct ? a : b));
            this._label.text = `${Math.round(max.pct)}%`;
            this._setColorClass(pickColorClass(max.pct));

            this._windowsSection.removeAll();

            const account = readAccountInfo();
            if (account) {
                this._addTitle('Account');
                if (account.email)
                    this._addValue(account.email);
                let orgLine = '';
                if (account.organizationName) {
                    orgLine = account.organizationName;
                    if (account.organizationRole)
                        orgLine += ` (${account.organizationRole})`;
                }
                if (account.subscriptionType)
                    orgLine = orgLine
                        ? `${orgLine} · ${account.subscriptionType} plan`
                        : `${account.subscriptionType} plan`;
                if (orgLine)
                    this._addValue(orgLine);
                this._addSpacer();
            }

            windows.forEach((w, i) => {
                if (i > 0)
                    this._addSpacer();

                const title = w.label === '5h' ? 'Current session (5h)' : 'Current week (7d)';
                this._addTitle(title);
                this._addBarLine(w.pct);
                if (w.resets_at)
                    this._addDetail(formatResetTime(w.resets_at));
                if (w.breakdown) {
                    for (const sub of w.breakdown)
                        this._addDetail(`  ${sub.label}: ${Math.round(sub.pct)}%`);
                }
            });

            const extra = json?.extra_usage;
            if (extra?.is_enabled) {
                this._addSpacer();
                this._addTitle('Extra credits');
                if (typeof extra.utilization === 'number')
                    this._addBarLine(extra.utilization);
                const used = extra.used_credits;
                const limit = extra.monthly_limit;
                if (used != null && limit != null)
                    this._addDetail(`${used} of ${limit} used`);
                else if (used != null)
                    this._addDetail(`${used} credits used`);
            }

            this._addSpacer();
            this._addDetail(`Updated at ${formatAbsoluteTime(this._lastRefresh)}`);
        }

        _addTitle(text) {
            const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
            item.label.add_style_class_name('claude-meter-section-title');
            this._windowsSection.addMenuItem(item);
        }

        _addValue(text) {
            const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
            item.label.add_style_class_name('claude-meter-section-value');
            this._windowsSection.addMenuItem(item);
        }

        _addBarLine(pct) {
            const item = new PopupMenu.PopupMenuItem(`${bar(pct)}  ${Math.round(pct)}%`, {reactive: false});
            item.label.add_style_class_name('claude-meter-section-bar');
            this._windowsSection.addMenuItem(item);
        }

        _addDetail(text) {
            const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
            item.label.add_style_class_name('claude-meter-section-detail');
            this._windowsSection.addMenuItem(item);
        }

        _addSpacer() {
            const item = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            item.add_style_class_name('claude-meter-spacer');
            this._windowsSection.addMenuItem(item);
        }

        _setColorClass(cls) {
            const all = ['claude-meter-normal', 'claude-meter-yellow', 'claude-meter-orange', 'claude-meter-red'];
            for (const c of all)
                this._label.remove_style_class_name(c);
            this._label.add_style_class_name(cls);
        }

        destroy() {
            if (this._timer) {
                GLib.source_remove(this._timer);
                this._timer = null;
            }
            this._client?.destroy();
            this._client = null;
            super.destroy();
        }
    },
);

export default class ClaudeMeterExtension extends Extension {
    enable() {
        this._indicator = new ClaudeMeterIndicator(this.path);
        Main.panel.addToStatusArea('claude-meter', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
