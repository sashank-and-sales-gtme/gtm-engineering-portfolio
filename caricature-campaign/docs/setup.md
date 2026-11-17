# Caricature Campaign Automation: Setup

Six n8n workflows, one Supabase database, one website snippet, five Instantly campaigns.

| # | Workflow | Trigger | Job |
|---|---|---|---|
| 1 | Prospect Intake | Webhook `POST /caricature-intake` | Creates the prospect, HubSpot contact, tracked QR link and Ship24 tracker |
| 2 | Delivery Tracker | Ship24 webhook + manual form | Sets Day 1 and the track (delivered or not delivered) |
| 3 | Intent Ingestor | Website pixel, Instantly, Factors, Maya webhooks | Logs every intent signal; QR scan, reply and Maya actions fire instantly |
| 4 | Intent Scorer | Daily 7:07 PT | 30-day score, Hot/Warm/Cold/Ice tiers, sales-ready call tasks, 90-day cooldown |
| 5 | Cadence Runner | Hourly | Enrolls leads in Instantly at the right time; creates Day 2/5/10/13 call tasks |
| 6 | Nurture Drafts | Daily 9:13 PT + approval link | Claude drafts nurture emails; one-click approve sends via Instantly |

---

## 1. Supabase

Run `supabase/migration.sql` in the Supabase SQL editor. It creates `campaign_config`, `prospects`, `events`, `nurture_drafts` and five views. Then fill the config row:

```sql
update campaign_config set
  n8n_base_url = 'https://your-n8n-host',
  slack_channel_id = 'C0XXXXXXX',
  hubspot_owner_id = '12345678',
  instantly_campaign_delivered = '<id>',
  instantly_campaign_not_delivered = '<id>',
  instantly_campaign_nurture_1 = '<id>',
  instantly_campaign_nurture_2 = '<id>',
  instantly_campaign_nurture_3 = '<id>'
where id = 1;
```

`campaign_timezone` defaults to `America/Los_Angeles` (day counting, meet dates). `contact_path` defaults to `/contact`.

## 2. HubSpot contact properties

Create these under Settings → Properties → Contact:

| Internal name | Type | Values |
|---|---|---|
| `caricature_stage` | Dropdown | Shipped, Delivered, Not delivered |
| `caricature_day1_date` | Date picker | |
| `caricature_lp_url` | Single-line text | |
| `caricature_intent_score` | Number | |
| `caricature_intent_tier` | Dropdown | Hot, Warm, Cold, Ice |

Create a HubSpot service key with contacts read/write plus notes and tasks access. A 403 on any "Create Note" or "Create Task" node means a missing scope.

## 3. Instantly campaigns

Create five campaigns. In every campaign: stop on reply ON, open tracking ON, link tracking ON, schedule in Pacific business hours. `{{orgName}}`, `{{meetDay}}`, `{{nurtureSubject}}` and `{{nurtureBody}}` are custom variables the workflows send with each lead.

### Caricature: Delivered (QR not scanned)

**Step 1 (sent when enrolled, Day 1 + 4 hours)**
Subject: `The mini-{{firstName}} on your desk`

```
{{firstName}},

Hope you like the caricature. For us, it's proof that real personalization breaks through.

But you can't send a doll to every visitor on {{orgName}}'s site. That's why we built InteractAI.

It's a product-aware agent that clones your best reps to deliver interactive demos 24/7.

We're currently 3x-ing MQLs for teams like Sprinto at zero CAC spend.

Can I send an interactive link to show you how?
```

**Step 2 (wait 3 days, Day 4)**, same thread

```
{{firstName}},

"Book a Demo" pages are where good intent goes to die because the delay to value is usually 48 hours.

When high-intent traffic hits a form instead of your product, the drop-off is roughly 40%.

InteractAI stops that leak with a "live" education layer on your site - delivering interactive demos the second interest peaks.

Sprinto booked 21 calls in 3 weeks doing exactly this.

Open to a 2-minute walkthrough?
```

**Step 3 (wait 3 days, Day 7)**, same thread

```
{{firstName}},

Writing this so your AEs don't have to spend 60% of their lives explaining "what we do" for the thousandth time.

Discovery calls are the ultimate bottleneck. It slows revenue while adding CAC spend.

InteractAI automates that education layer - qualifying MQLs and mapping use cases via interactive demos while your team actually closes.

Sprinto and Yellow.ai use InteractAI to scale without the headcount headache.

Blue Bottle this {{meetDay}}? Bagels on me.
```

### Caricature: Not delivered

**Step 1 (sent when enrolled, Day 1 of rejection)**
Subject: `Your caricature got stuck at the door`

```
{{firstName}},

Logistics 1: InteractAI 0.

We tried to send a little something for your desk, but {{orgName}}'s mailroom sent it back. My guess is security isn't fond of unexpected packages.

I'd still love to get this to you. Is there a better address for a one-time delivery, or should I just hold onto it for a future Blue Bottle run?
```

**Step 2 (wait 2 days, Day 3)**
Subject: `Since the mailroom is playing goalie...`

```
{{firstName}},

While I figure out how to get that caricature past your security team, I didn't want the "Why" behind it to get lost.

The doll was a play on personalization, something we've automated for {{orgName}}'s website.

Since the physical version is in transit, I set up a digital one for you here: https://dev.interactnow.ai

It shows how Sprinto is booking 21 extra calls a month by replacing forms with live demos.

Worth a 60-second look while I recalibrate the delivery?
```

**Step 3 (wait 4 days, Day 7)**
Subject: `Bagels to the rescue`

```
{{firstName}},

I'm officially calling off the delivery drones. The caricature is back at our office for now.

I'll be in SF at Blue Bottle this {{meetDay}}. If you're going to be in the office, I'd love to just hand-deliver it with a Bagel.

If not, I'll take the hint and put the mini-{{firstName}} in our Hall of Fame.

Either way, hope the Maya link gave you some ideas for the {{orgName}} funnel.
```

### Caricature: Nurture 1, Nurture 2, Nurture 3

One step each. Subject `{{nurtureSubject}}`, body `{{nurtureBody}}`. Workflow 6 fills both after a human approves the Claude draft.

### Instantly webhook

Integrations → Webhooks → Add Webhook. Target: `https://your-n8n-host/webhook/caricature-instantly`, event type: all events, custom header `X-Webhook-Secret: <secret>`.

## 4. n8n credentials

| Credential | Type | Used by |
|---|---|---|
| Supabase | Supabase API (host + service role key) | All Supabase nodes |
| HubSpot | HubSpot App Token (service key) | All HubSpot HTTP nodes |
| Instantly API | Header Auth: `Authorization` = `Bearer <api key>` | Instantly HTTP nodes |
| Ship24 API | Header Auth: `Authorization` = `Bearer <api key>` | Ship24: Create Tracker |
| Slack | Slack API (bot token with `chat:write`) | All Slack nodes |
| Anthropic | Anthropic API | Claude Nurture Writer model |
| Intake secret | Header Auth: `X-Intake-Secret` = `<secret>` | Intake Webhook |
| Ship24 webhook secret | Header Auth: `Authorization` = `Bearer <Ship24 webhook secret>` | Ship24 Webhook |
| Instantly webhook secret | Header Auth: `X-Webhook-Secret` = `<secret>` | Instantly Webhook |
| Factors and Maya secrets | Header Auth, any header name you configure on the sender | Factors Webhook, Maya Webhook |

Import the six JSON files, select credentials on each node, then activate all six.

## 5. External webhooks

- **Ship24 dashboard:** Webhook URL `https://your-n8n-host/webhook/caricature-ship24`.
- **Factors or Midbound:** account-visit alerts to `https://your-n8n-host/webhook/caricature-factors` with a `domain` field (the Factors `MessageProperty` format also works).
- **Maya:** if Maya can emit events, POST `{ "email": "...", "detail": "..." }` or `{ "pid": "<token>" }` to `https://your-n8n-host/webhook/caricature-maya`. Without it, clicks on the `dev.interactnow.ai` link in Instantly emails count as Maya interactions.

## 6. Website snippet

Paste `website/tracking-snippet.html` before `</body>` on every page of interactlabs.ai and set `ENDPOINT` to `https://your-n8n-host/webhook/ia-track`. To track demo engagement, add `data-ia-demo` to the element that launches the interactive demo, or call `window.iaTrackDemo()` from the demo's start event. Only visitors who arrived through their caricature QR code are tracked; update the site's privacy notice to cover this.

## 7. Add prospects

```bash
curl -X POST https://your-n8n-host/webhook/caricature-intake \
  -H 'Content-Type: application/json' -H 'X-Intake-Secret: <secret>' \
  -d '{"prospects":[{"email":"priya@acme.io","first_name":"Priya","last_name":"Rao","title":"VP Marketing",
       "company_name":"Acme Labs","carrier":"fedex","tracking_number":"1Z999AA10123456784"}]}'
```

The response and the Slack summary carry each prospect's `qr_png_url` (print-ready PNG) and `lp_url`. Send the QR images to Wayo for the Hallmark cards. Leave `tracking_number` empty or set `carrier` to `doordash` for untracked couriers; confirm those deliveries through the form at `https://your-n8n-host/form/caricature-delivery-confirm`.

## How scoring works

Signals in the last 30 days are summed and capped at 100: website visit 2, three or more visits in 14 days 15, QR landing 35, demo engaged 40, QR session reaching the contact page 45. Tiers come from each prospect's position in the active cohort: top 25% Hot, up to 45% Warm, up to 60% Cold, the rest Ice. Prospects tied on a score share the lower position, so prospects with zero signals are always Ice. Hot and Warm are sales ready and get a HubSpot call task the first time they reach it. Cold and Ice prospects get a Claude-drafted nurture email after their 13-day sequence (or 7 days after a QR scan); after three nurture campaigns without improving, they enter a 90-day cooldown.
