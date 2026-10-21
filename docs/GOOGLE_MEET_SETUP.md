# Connecting Google, so a meeting gets a real Meet link

**Written 21 October 2026.** For whoever runs the server. Doing this once lets each salesperson connect their own
Google account; after that, arranging a meeting can mint a genuine Meet link and put the meeting in that person's own
Google Calendar.

**You do not have to do any of this.** Without it, meetings still work: everybody invited gets a calendar invitation
with Accept and Decline, and the organiser pastes their own Meet, Zoom or Teams link. Connecting Google only saves
them that step.

---

## Before you start: what Google will and will not allow

This matters more than the setup itself, so read it first.

- **The app must be published, not left in "Testing".** Google expires a refresh token after **seven days** for an app
  whose consent screen is still in Testing, so the connection would break every week. Press **Publish app**.
- **Ordinary Gmail accounts mean the app is "External".** The "Internal" option, which Google exempts from review
  entirely, exists only for a Google Workspace organisation (email on your own domain through Google). If your people
  use `@gmail.com`, Internal is not available to you.
- **Until Google reviews it, an External app shows a warning screen and is capped at 100 accounts.** The warning is the
  "Google hasn't verified this app" page; a person can go on through **Advanced → Go to … (unsafe)**. One hundred
  connected accounts is plenty to start, and you submit for verification when you outgrow it.

If your people do have Google Workspace, choose **Internal** at step 3 and none of the above applies.

---

## 1. Make a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in with the account that should own this.
2. Top left, the project picker → **New project**. Name it after the product, for example `Zarvia CRM`. Create it, and
   make sure it is the project selected afterwards.

## 2. Switch the Calendar API on

1. **APIs & Services → Library**.
2. Search for **Google Calendar API** and press **Enable**.

That is the only API needed. The Meet link is made by Calendar as part of creating the event.

## 3. Set up the consent screen

1. **APIs & Services → OAuth consent screen**.
2. **User type**: *Internal* if you have Google Workspace and only your own staff will connect; otherwise *External*.
3. Fill in the app name, a support email and a developer contact email. The app name is what people see on the consent
   screen, so use the name they know you by.
4. **Scopes → Add or remove scopes**, and add exactly one:

   ```
   https://www.googleapis.com/auth/calendar.events
   ```

   Google marks it *sensitive*. Nothing else is needed, and asking for less is what keeps the review simple if you ever
   submit for one.
5. **External only:** add each person who will connect as a **Test user** while you are trying it out, then come back
   and press **Publish app** before anybody relies on it. Remember the seven-day rule above.

## 4. Make the credentials

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type**: *Web application*.
3. **Authorised redirect URIs** → Add, and enter exactly the address of the app, followed by `/crm/google/callback`:

   | Where | What to enter |
   | --- | --- |
   | Live | `https://your-app-address/crm/google/callback` |
   | A laptop, for trying it | `http://localhost:5173/crm/google/callback` |

   It must match **character for character**, including `http` or `https` and any trailing path. A mismatch is the most
   common failure, and Google says so plainly: `redirect_uri_mismatch`.
4. Create it, and copy the **Client ID** and **Client secret**.

## 5. Tell the server

Three settings. On Render they go in the service's Environment; on a laptop, in `trade ERP node/.env`.

```
GOOGLE_CLIENT_ID=<the client id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<the client secret>
PUBLIC_APP_URL=https://your-app-address
```

`PUBLIC_APP_URL` is what the redirect address is built from, so it must be the address people actually open the app at,
with no trailing slash. On a laptop that is `http://localhost:5173`.

Restart the server. Until all three are set, the feature simply is not offered: the Settings panel says so rather than
showing a button that could only fail.

## 6. Each person connects their own account

**Settings → Security → Google Calendar → Connect Google.**

It is per person on purpose: the Meet link is minted by their account and the event goes in their own diary, so two
salespeople connect separately and neither can act as the other.

Afterwards, **Arrange a meeting** shows a tick, *Make a Google Meet link for me*.

---

## What you should expect to see

- **"Google hasn't verified this app"** on an unverified External app. Expected. **Advanced → Go to …** to continue.
- **A tick for the calendar permission** on the consent screen. If somebody unticks it, we refuse the connection and
  say why, rather than letting them find out when a meeting has no link.
- **The link, in the invitation.** Google is told *not* to send its own invitation (`sendUpdates=none`), because we
  send ours. Attendees get one email, not two.

## When something goes wrong

| What you see | What it means |
| --- | --- |
| `redirect_uri_mismatch` | The address in step 4 is not exactly `PUBLIC_APP_URL` + `/crm/google/callback`. |
| "Google did not give a lasting permission" | Google withheld the refresh token. Remove the app at <https://myaccount.google.com/permissions> and connect again. |
| "The Google connection has expired" | The permission was withdrawn, or the app is still in Testing and the seven days have passed. Publish the app, then connect again. |
| "The calendar permission was not granted" | The box was unticked on the consent screen. Connect again and leave it ticked. |
| Connected, but no link on the meeting | Google made the event and no conference. The meeting is fine; add a link by hand. The screen says this. |

## What this does not do

- **It does not read anybody's calendar.** The one permission asked for is to create and change events; we never list
  what else is in their diary, so there is no free/busy check.
- **It does not capture a reply.** When a customer presses Accept, that email goes to the organiser's own mailbox.
- **It does not connect an organisation, only a person.** There is no shared company calendar.
- **It is not needed for meetings to work.** Everything still happens without it.
