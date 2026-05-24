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
import Soup from 'gi://Soup';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const USER_AGENT = 'claude-meter-gnome/1.0';

export function credentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

function claudeJsonPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude.json']);
}

export function readAccessToken() {
    const path = credentialsPath();
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error(`cannot read ${path}`);
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const token = data?.claudeAiOauth?.accessToken;
    if (!token)
        throw new Error('claudeAiOauth.accessToken missing in credentials.json');
    return token;
}

export function readAccountInfo() {
    const info = {};

    const [credOk, credBytes] = GLib.file_get_contents(credentialsPath());
    if (credOk) {
        try {
            const oauth = JSON.parse(new TextDecoder().decode(credBytes))?.claudeAiOauth;
            if (oauth?.subscriptionType) info.subscriptionType = oauth.subscriptionType;
            if (oauth?.rateLimitTier) info.rateLimitTier = oauth.rateLimitTier;
        } catch (e) {}
    }

    const [jsonOk, jsonBytes] = GLib.file_get_contents(claudeJsonPath());
    if (jsonOk) {
        try {
            const acc = JSON.parse(new TextDecoder().decode(jsonBytes))?.oauthAccount;
            if (acc?.emailAddress) info.email = acc.emailAddress;
            if (acc?.displayName) info.displayName = acc.displayName;
            if (acc?.organizationName) info.organizationName = acc.organizationName;
            if (acc?.organizationRole) info.organizationRole = acc.organizationRole;
        } catch (e) {}
    }

    return Object.keys(info).length > 0 ? info : null;
}

export class UsageClient {
    constructor() {
        this._session = new Soup.Session({user_agent: USER_AGENT, timeout: 15});
    }

    fetchUsage(callback) {
        let token;
        try {
            token = readAccessToken();
        } catch (e) {
            callback(null, e);
            return;
        }

        const msg = Soup.Message.new('GET', USAGE_URL);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('anthropic-beta', ANTHROPIC_BETA);
        headers.append('Accept', 'application/json');

        this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const status = msg.get_status();
                    if (status !== Soup.Status.OK) {
                        callback(null, new Error(`HTTP ${status}`));
                        return;
                    }
                    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    callback(json, null);
                } catch (e) {
                    callback(null, e);
                }
            },
        );
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}
