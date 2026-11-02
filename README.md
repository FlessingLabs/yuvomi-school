# FlessingLabs Timetable (Stundenplan)

[Deutsch](README.de.md) · **English**

A Yuvomi module for lessons, childcare and afternoon activities per child. It answers one question first of all:

**Where is my child according to plan right now, what comes next, and when are they expected home?**

> **Needs Yuvomi with module storage *and* per-person grants.** Those are migrations 274 and 275 of the FlessingLabs fork (branch [`feat/module-storage`](https://github.com/FlessingLabs/yuvomi/tree/feat/module-storage), image `ghcr.io/flessinglabs/yuvomi:module-storage-…`, from the build that has migration 275). Official Yuvomi has neither. On a Yuvomi without them the timetable shows a message and stores nothing, because without server-side separation every child's plans would be visible to everyone.

All times are **planned times**: no location tracking, no confirmation of arrival. Once the time has passed, the module does not claim the child is home.

## What it does

- **Today:** a card per child with the current and next section, the last entry of the day and the expected time home, or "arrival home still open" with the reason. Changes for the day are clearly marked. Other days via the date picker.
- **Week:** a timetable per child (or "All" one below the other): periods as rows, breaks between them, afternoon and home time below. Absence, holidays and changes show right in the column.
- **PDF:** week or plan as a landscape A4 PDF: tap "PDF", then "Save as PDF" in the print dialog. With A/B weeks each week gets its own page.
- **Dashboard tile** ("Timetable today", under Overview → Customize): whoever has a plan of their own, i.e. the child, sees only their day with lessons, rooms, breaks and home time. Whoever has none (parents) sees one line per child. Once the day is over it shows the next school day.
- **Plans:**
  - Each child has their own plans with a name and a validity period.
  - Per weekday: lessons, optional childcare, optional activities (with place) and what happens afterwards (home or pick-up).
  - Time for the way home per place.
  - A holiday rule for childcare and activities.
  - Optional A/B weeks.
  - **Lesson periods:** enter the times of the school periods once (for all children at one school); in a plan, choose only “from period – to period”. If the school changes its times, only the periods change. A day's change can say “ends after period …”.
  - "Same as Monday" copies a day. "Copy as new plan" serves as the template for the next school year.
  - Class and class teacher with contact per plan.
  - "Copy to another child": siblings with the same timetable; childcare and activities only on request.
- **Change for one day:**
  - no school, or away;
  - lessons cancelled or ending early;
  - childcare cancelled or at other times;
  - an activity cancelled or moved;
  - pick-up or straight home;
  - plus a note.

  The weekly plan stays unchanged.

## How the time home is computed

- The basis is the plan that applies on that day. If none applies, it says "no plan"; if several apply, the overlap is named.
- The **last entry** of the day counts, not the number of lessons. Then whatever the weekday's "then" says applies:
  - **home:** end of the last entry plus the way home from its place;
  - **pick-up:** an entered arrival time, or pick-up time plus driving time.
- **Arrival stays open** when something is missing or contradictory: travel time for the place, pick-up time, an overlap, an end before the start. Likewise when a change cancels something without saying what happens instead. If drama is cancelled, the module does **not** compute an earlier arrival; the change has to say "longer childcare" or "straight home".
- **Gaps** between entries show as "nothing entered", never as childcare. Between two lessons a gap is a **break**.
- A day without entries says "nothing entered", not "no school".
- **Holidays** come from Yuvomi (Settings → Holidays: country, region, "show school holidays"). On such days lessons are off; childcare and activities follow the plan's holiday rule (takes place, cancelled, open). Without holiday data or without the right to read the calendar, the page says so.
- **A/B weeks:** an A week starts on the date entered; from there it alternates by calendar week. Holidays do not shift the rhythm.
- Everything is computed in the **household time zone** (Yuvomi setting), also on daylight-saving days and on devices in another zone.

## Who sees what

Children are normal Yuvomi users; the module creates no children or accounts of its own. Every plan belongs to one user, and **Yuvomi checks on the server** on every access:

| Who | A child's plans |
|---|---|
| Admin | see and maintain |
| The child | see |
| Whoever an admin granted access for this child | see, or see and maintain |
| Everyone else | nothing; the plans do not exist for them |

An admin sets the grants under **Settings → Modules → Timetable**.

**Lesson periods** belong to no child; they are household-wide: anyone with access to the timetable may read them, anyone with **write** access to the module may change them. To keep children from changing them, set children to **Read** for the timetable under Settings → Household → Roles & permissions; they still see their own plan. Nothing is derived from role, name or age. The module permission "Timetable" under Roles & permissions stays the outer gate.

A child removed from the household is deactivated rather than deleted. Their plans stay and can never end up with somebody else. A removed person loses their grants.

## Installation

1. Run **Yuvomi with module storage**, i.e. the fork image with migration 275. The start-up log must show `Migration 275 applied`. Unraid guide with backup and the way back: [QuickShop – UNRAID-TEST.de.md](https://github.com/FlessingLabs/yuvomi-quickshop/blob/feat/core-storage/docs/UNRAID-TEST.de.md) (German); the steps are the same.
2. Install the module, either:
   - from Settings → Modules → Add custom module (needs `MODULES_ALLOW_WEB_INSTALL=true`) with
     `https://github.com/FlessingLabs/yuvomi-school/tree/main/module`
   - or by hand on Unraid:
     ```sh
     cd /tmp && rm -rf yuvomi-school-main && curl -sL https://codeload.github.com/FlessingLabs/yuvomi-school/tar.gz/refs/heads/main | tar xz
     cp -r /tmp/yuvomi-school-main/module /mnt/user/appdata/yuvomi/modules/flessinglabs-school
     ```
3. Switch it on under Settings → Modules (when installed from the interface).
4. Under **Settings → Modules → Timetable**, set who may see or maintain which child's plans.
5. Under **Plans**, create a plan per child.

**Updating:** the same steps. Plans live in Yuvomi's database and survive updates and disabling or removing the module. They are part of Yuvomi's backup.

**Module id:** `flessinglabs-school`. It is fixed; repository name and display name may differ.

## Development and tests

```sh
npm test    # day computation (acceptance cases), storage client, holidays, plan checks, translations
node tools/e2e/e2e-school.mjs setup   --base http://127.0.0.1:3000 --user admin --password …   # against a test Yuvomi
node tools/e2e/e2e-school.mjs persist --base http://127.0.0.1:3000 --user admin --password …   # after a restart
node tools/e2e/e2e-school.mjs readonly --base http://<server>:<port> --user … --password …       # read-only
```

The acceptance test creates test members prefixed `e2e`. It belongs on a test system, not on the family installation.

## Not included

Location/GPS, presence detection, AI, school-portal import, grades, chat, automatic notifications, a child management of its own.

## License

MIT, © 2026 FlessingLabs.
