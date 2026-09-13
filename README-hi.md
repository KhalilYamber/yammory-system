<div align="center">

# yammory_system

**DeepSeek Harness के लिए परिबद्ध, स्तरित, अनुमोदन-द्वारी, लेखा-परीक्षण-योग्य क्रॉस-सेशन मेमोरी।**

*एक टाइप्ड `ctx.memory` सीम, एक लेखन-अनुमोदन द्वार जिसे मॉडल का कोई मार्ग नहीं टाल सकता, और सत्र लॉग से पुनर्निर्माण-योग्य ऑडिट ट्रेल।*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](#)
[![CI](https://img.shields.io/github/actions/workflow/status/KhalilYamber/yammory-system/ci.yml?branch=main&label=CI)](https://github.com/KhalilYamber/yammory-system/actions)
[![Version](https://img.shields.io/github/v/tag/KhalilYamber/yammory-system?label=version)](https://github.com/KhalilYamber/yammory-system/releases)

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

</div>

---

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `dsh-v0.1.5-rc.2` (2026-09-09 को अनुकूलित): सत्र लिफ़ाफ़ा अपना ignorable फ़ील्ड केवल संग्रहीत-लॉग पठन संगतता के लिए रखता है - Session.append अभी भी इसे स्टैम्प नहीं कर सकता, इसलिए गेट व्यवहार अपरिवर्तित है। dsh-v0.1.5-rc.2 master checkout के विरुद्ध 2026-09-11 को सत्यापित (पूर्ण गेट शृंखला + प्रोफ़ाइल इंस्टॉल स्मोक)। |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | Windows / macOS / Linux (केवल host; कोई नेटिव कोड नहीं, कोई नेटवर्क नहीं) |
| Model | कोई भी |

## What you get

`yammory_system` एक क्षमता-सीम है, कोई दूसरा भंडार नहीं: एक टाइप्ड `ctx.memory` सेवा, एक स्थानीय SQLite प्रदाता (`node:sqlite`, WAL, `0600`, `$DSH_HOME/dsh-memento/memory.db` पर) और उसके उपभोक्ता — `memory` टूल और सिस्टम प्रॉम्प्ट में इंजेक्ट किया गया फ़्रोज़न स्नैपशॉट।

- **अनुमोदन द्वार को टाला नहीं जा सकता।** हर लेखन पथ (`add` / `replace` / `remove` / `seed`) सेवा के भीतर अनुमोदन वॉटरफ़ॉल से होकर गुज़रता है, टूल परत से नहीं। `writePolicy: ask | auto | off` मॉडल के लिए अदृश्य विन्यास है; `replace` / `remove` / `consolidate` अनुमोदन पेलोड में बदली जाने वाली प्रविष्टियों का पूरा पाठ ले जाते हैं, और अस्वीकृत लेखन भी एक `*-denied` ऑडिट पंक्ति छोड़ता है।
- **मॉडल-दृश्य ⟺ लॉग किया गया।** इंजेक्ट किया गया स्नैपशॉट `system/message` में शब्दशः पहुँचता है; हर लेखन `approval/asked` + `approval/decided` + प्लगइन की अपनी ऑडिट तालिका से पुनर्निर्माण-योग्य है।
- **परिबद्ध और ईमानदार।** प्रति-ट्रैक/प्रति-परत कठोर अक्षर बजट (डिफ़ॉल्ट user 2000 / agent 4000)। भरा हुआ भंडार संरचित त्रुटि से विफल होता है (उपयोग + सीमा) — कभी काटा नहीं, कभी स्वतः संकुचित नहीं।

दो ट्रैक × दो परतें × प्रति-एजेंट कुंजी: एक `user` ट्रैक (उपयोगकर्ता के बारे में तथ्य) और एक `agent` ट्रैक (पर्यावरण तथ्य और परंपराएँ), प्रत्येक `user-global` और `workspace` परतों में बँटा, `agentPreset` के अनुसार पृथक। स्नैपशॉट पहले प्रॉम्प्ट संयोजन पर प्रति-सत्र एक बार फ़्रीज़ होता है और सत्र के बीच कभी नहीं बदलता। वॉर्म-अप ब्लॉक अभिव्यक्ति-बाधाएँ और स्थायी प्रोफ़ाइल रखता है, और एक पंक्ति की निर्देशिका से समाप्त होता है (`N more workspace / agent-track entries stay out of this block`), ताकि मॉडल जान सके कि `memory_recall` से लाने योग्य कुछ है——केवल गिनती, सामग्री माँगने पर ही।

## Quick start

```sh
# 1. install the bundle into your profile
dsh plugin --profile web add "github:KhalilYamber/yammory-system#main"

# or from npm (published releases)

# 2. restart and verify the row
dsh --profile web --dump-config | grep -A3 'id: yammory_system'
```

## Install & uninstall

- **git चैनल** (नवीनतम `main`): `dsh plugin --profile web add git+https://github.com/KhalilYamber/yammory-system.git`.
- **tarball चैनल**: इस रेपो में `npm pack`, फिर `dsh plugin --profile web add ./yammory_system-<version>.tgz`.
- **uninstall**: `dsh plugin --profile web remove yammory_system` (मेमोरी डेटाबेस और सत्र लॉग रखे जाते हैं)।

## Configuration

सभी ट्यूनेबल Schemastery `Config` फ़ील्ड हैं (cordis.yml से बदले जा सकते हैं)। अमान्य मान लोड पर ज़ोर से विफल होते हैं। `yammory_system` पंक्ति के अंतर्गत ओवरराइड करें।

**सेटिंग्स पैनल।** DSH सेटिंग्स सेवा माउंट होने पर नीचे के सभी फ़ील्ड (`enabled` को छोड़कर) DSH सेटिंग्स साइडबार की प्लगइन **`yammory-system` प्रविष्टि** से संपादित होते हैं (General या Plugins जैसा एक शीर्ष-स्तरीय खंड); बदलाव सेटिंग्स यूज़र लेयर (`settings.yaml`) में जाते हैं, फ़ाइल छूने की ज़रूरत नहीं। लगभग सब लाइव लागू होते हैं (राइट पॉलिसी, भाषा, बजट, सीमाएँ, प्रस्ताव, पैनल; `dbPath` / `auditRetentionDays` स्टोर पुनः खोलकर; `retrieval.vector` रिट्रीवर बदलकर) — केवल `snapshotOrder` को DSH रीलोड चाहिए। सेटिंग्स सेवा के अभाव में सब कुछ संयुक्त cordis कॉन्फ़िग पर लौटता है, पहले जैसा। फ़्लोटिंग पैनल बटन उसी पृष्ठ से छिपाया जा सकता है (`panel.enabled`)।

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | मुख्य स्विच; `false` सेवा, टूल, स्नैपशॉट, कमांड, पैनल और answerer हटा देता है (सेटिंग्स पृष्ठ से संपादन योग्य नहीं — अक्षम प्लगइन की कोई सेटिंग्स प्रविष्टि नहीं) |
| `panel.enabled` | `true` | वेब पैनल का फ़्लोटिंग बटन दिखाएँ; सेटिंग्स पृष्ठ से `false` सेव करने पर 🧠 प्रविष्टि तुरंत छिप जाती है, रीलोड की ज़रूरत नहीं (सेटिंग्स पृष्ठ अप्रभावित) |
| `dbPath` | `''` → `$DSH_HOME/dsh-memento/memory.db` | निरपेक्ष, या `$DSH_HOME` के सापेक्ष (Windows पर `~/.dsh` पर फ़ॉलबैक) |
| `budgets.user.userGlobal` | `2000` | user ट्रैक की user-global परत की अक्षर चेतावनी रेखा |
| `budgets.user.workspace` | `2000` | user ट्रैक की workspace परत की अक्षर चेतावनी रेखा |
| `budgets.agent.userGlobal` | `4000` | agent ट्रैक की user-global परत की अक्षर चेतावनी रेखा |
| `budgets.agent.workspace` | `4000` | agent ट्रैक की workspace परत की अक्षर चेतावनी रेखा |
| `writePolicy` | `'ask'` | डिफ़ॉल्ट लेखन नीति: `ask` / `auto` / `off` (मॉडल-अदृश्य) |
| `writePolicies` | `{}` | प्रति-ट्रैक/स्कोप या प्रति-स्रोत ओवरराइड (जैसे `user/workspace`, `source:claude`) |
| `language` | `'en'` | मॉडल-दृश्य और कमांड आउटपुट भाषा: `en` / `zh` |
| `snapshotOrder` | `-50` | स्नैपशॉट अनुभाग क्रम (harness पहचान के बाद, persona से पहले) |
| `maxEntriesPerQuery` | `20` | डिफ़ॉल्ट प्रति-क्वेरी परिणाम सीमा (कठोर सीमा 1000) |
| `commandListLimit` | `50` | प्रति `/memory list` / `query` प्रदर्शित प्रविष्टियाँ |
| `commandAuditLimit` | `10` | प्रति `/memory audit` प्रदर्शित ऑडिट पंक्तियाँ |
| `recall.historyLimitDefault` | `8` | `memory_recall` द्वारा डिफ़ॉल्ट स्कैन किए गए सत्र |
| `recall.snippetCap` | `5` | `memory_recall` में प्रति-सत्र स्निपेट |
| `recall.snippetChars` | `300` | `memory_recall` स्निपेट अक्षर |
| `recall.windowDays` | `30` | `memory_recall` की दिनों में हाल-समय विंडो |
| `observe.days` | `14` | `memory_observe scan` की दिनों में विंडो (कठोर सीमा 90) |
| `observe.sessions` | `8` | प्रति स्कैन नमूने के रूप में लिए गए हाल के सत्र (कठोर सीमा 20) |
| `observe.perSession` | `12` | प्रति सत्र नमूने के रूप में लिए गए संदेश, समान अंतराल पर—ताकि शुरुआत और बाद के सुधार दोनों बचे रहें (कठोर सीमा 20) |
| `observe.messageChars` | `400` | अंडरस्कोर से काटने से पहले प्रति संदेश अक्षर सीमा (कठोर सीमा 800) |
| `observe.totalChars` | `12000` | पूरे स्लाइस का अक्षर बजट; वहीं रुकता है और जो कवर नहीं हुआ वह बताता है (कठोर सीमा 30000) |
| `retrieval.vector` | `false` | सिमेंटिक रिकॉल स्विच: `true` से `memory_recall` वेक्टर रिकॉल (फ़ेक हैश एम्बेडिंग) सक्षम होता है जब कोई एम्बेडिंग प्रदाता उपलब्ध हो; अन्यथा शून्य-निर्भरता keyword रिट्रीवर (CJK बाइग्राम टोकनाइज़िंग, किसी भी टोकन पर मिलान, प्रासंगिकता क्रम) बना रहता है |
| `panelEntriesLimit` | `200` | वेब पैनल प्रविष्टि पृष्ठ आकार |
| `panelAuditLimit` | `20` | वेब पैनल डिफ़ॉल्ट ऑडिट पंक्तियाँ |
| `auditRetentionDays` | `0` | ऑडिट अवधारण (0 = हमेशा रखें) |
| `proposals.enabled` | `true` | हर सफल संघनन के बाद स्वतः एक मेमोरी प्रस्ताव कैप्चर करें |
| `proposals.maxChars` | `2000` | प्रस्ताव अक्षर सीमा |
| `proposals.maxPending` | `8` | लंबित प्रस्ताव सीमा |

## Tools & surfaces

| Surface | Kind | Notes |
|---|---|---|
| `memory` | tool | Save/Skip मार्गदर्शन के साथ add/replace/remove/consolidate/query; प्रविष्टियाँ वैकल्पिक प्रोफ़ाइल निर्देशांक रख सकती हैं (`facet` = सात में से एक, `level` = प्रति-क्षेत्र ज्ञान स्तर); लेखन अनुमोदन द्वार से गुज़रता है |
| `memory_profile` | tool | 31 उप-क्षेत्रों के पैमाने पर प्रति-क्षेत्र ज्ञान स्तर (`set` / `list` / `get`); `set` अनुमोदन द्वार से गुज़रता है और ऑडिट होता है, `tier` `level` से निकलता है |
| `yammory-survey` | skill | उपयोगकर्ता द्वारा शुरू की गई प्रोफ़ाइल प्रश्नावली, 24 प्रश्नावली-योग्य उप-खंडों को कवर करती है; `memory` + `memory_profile` से लिखती है। स्रोत: `skills/yammory-survey/` |
| `memory_recall` | tool | परिबद्ध मेमोरी मिलान (क्वेरी टोकनयुक्त: CJK बाइग्राम, लैटिन शब्द ज्यों के त्यों; कोई भी टोकन मिलने पर रिकॉल, प्रासंगिकता क्रम में) + हाल के सत्र-इतिहास मिलान |
| `memory_observe` | tool | अवलोकन चैनल: `scan` उपयोगकर्ता के अपने पुराने संदेशों का परिबद्ध स्लाइस पढ़ता है (केवल-पठन, `cwd` से सीमित, सिस्टम-इंजेक्टेड छद्म संदेश छाँटे और गिने जाते हैं, बजट की कमी बताई जाती है); `commit` एक ही अनुमोदन वाले परमाणु बैच में साक्ष्य-सहित 1..8 प्रविष्टियाँ लिखता है, `source: observation` के साथ |
| `yammory-observe` | skill | उपयोगकर्ता द्वारा शुरू किया गया व्यवहार-अवलोकन, जो पाँच केवल-अवलोकन पक्षों (सोच शैली, कठिनाई में चरित्र, भावनात्मक पैटर्न, आत्म-छवि, निर्णय शैली) को `memory_observe` से लिखता है। स्रोत: `skills/yammory-observe/` |
| `/memory` | command | `list` · `query` · `add` · `remove` · `consolidate` · `proposals` · `budgets` · `audit` · `export` · `import <path>` · `adapters` · `observe [--days=N]` |
| web panel | client drawer | केवल-पठन: प्रविष्टियाँ ब्राउज़ करें, खोजें, बजट बार, ऑडिट पूँछ; फ़्लोटिंग बटन छिपाया जा सकता है (`panel.enabled`) |
| settings section | DSH सेटिंग्स साइडबार → `yammory-system` | फ़ाइल छुए सभी कॉन्फ़िग फ़ील्ड संपादित करें (`enabled` को छोड़कर); लाइव/रीलोड समय पृष्ठ पर अंकित |

## MCP server

`yammory_system` एक केवल-पठन stdio **MCP सर्वर** (`yammory_system-mcp`) भी देता है ताकि बाहरी MCP क्लाइंट (Claude, Codex, …) बिना harness के मेमोरी स्टोर खोज सकें। यह newline-delimited JSON (NDJSON) पर JSON-RPC 2.0 बोलता है — प्रति पंक्ति एक JSON ऑब्जेक्ट, कोई `Content-Length` फ़्रेमिंग नहीं।

**केवल-पठन।** डेटाबेस `node:sqlite` के `readOnly: true` से खुलता है (कोई माइग्रेशन नहीं, कोई WAL लेखन नहीं, recall-count में वृद्धि नहीं); अगर फ़ाइल मौजूद नहीं है तो क्रैश के बजाय खाली परिणाम मिलते हैं।

| टूल | उद्देश्य |
|---|---|
| `memory_search` | `{query, limit?}` → क्रमबद्ध प्रविष्टियाँ (retrieval Provider seam से केस-इनसेंसिटिव सबस्ट्रिंग) |
| `memory_stats` | `{}` → `{total, namespaces}` प्रविष्टि गणना + track/scope अवलोकन |

सीधे चलाएँ:

```sh
node bin/mcp-server.mjs
# या, npm install के बाद: npx yammory_system-mcp
```

डेटाबेस पथ `$DSH_MEMENTO_DB_PATH` है (निरपेक्ष, या `$DSH_HOME` के सापेक्ष); डिफ़ॉल्ट `$DSH_HOME/dsh-memento/memory.db`।

Claude Desktop (`claude_desktop_config.json`) उदाहरण:

```json
{
  "mcpServers": {
    "yammory_system": {
      "command": "npx",
      "args": ["-y", "yammory_system-mcp"],
      "env": {
        "DSH_MEMENTO_DB_PATH": "/home/you/.dsh/dsh-memento/memory.db"
      }
    }
  }
}
```

सर्वर केवल-पठन है: कोई नेटवर्क नहीं, कोई लेखन नहीं, कोई अनुमोदन द्वार नहीं — केवल खोज और आँकड़े।

## How it's different

| Plugin | यह क्या है | yammory_system का अंतर |
|---|---|---|
| dsh-memory-evolve | मेमोरी वेयरहाउस / इवोल्यूशन लूप | टाइप्ड सेवा सीम, अनुमोदन द्वार और सत्र-लॉग ऑडिट; कोई वेयरहाउस महत्वाकांक्षा नहीं |
| dsh-mnemon | मेमोरी स्टोर सहायक | प्रोटोकॉल + द्वार + ऑडिट, कोई दूसरा स्टोर नहीं |
| dsh-kb-sieve | ज्ञान-आधार छानना | कोई रिट्रीवल इंजीनियरिंग नहीं: छोटे-कोर्पस सबस्ट्रिंग खोज, `session_search`/`sessionQuery` से क्रॉस-सेशन रिकॉल |
| dsh-tdai-memory | कार्य-संचालित मेमोरी टूलिंग | बजट प्रति track×परत और सेवा में लागू, न कि सर्वोत्तम-प्रयास |
| claude-bridge | Claude Code ब्रिजिंग | DSH-नेटिव; भविष्य का `seed(source:'claude')` पथ एक ब्रिज को वही स्टोर भरने देता है |
| dsh-external/Recall | बाहरी एजेंट मेमोरी | स्थानीय-प्रथम, शून्य-नेटवर्क, DSH की अपनी अनुमोदन सीम पर चलता है |
| Official MCP memory examples | DSH की घोषित "मेमोरी = बाहरी MCP" स्थिति | **नेटिव फर्स्ट-पार्टी** पूरक: समान लक्ष्य, कोई बाहरी सर्वर नहीं; दोनों सह-अस्तित्व |

नाम **`yammory_system`** है (npm और GitHub पर प्रकाशित)। `dsh-recall` नहीं (dsh-external/Recall से भ्रमित होने वाला), न ही हटाया गया विरासत नाम `dsh-memory`।

## dsh-memory-protocol v1

`yammory_system` DSH मेमोरी प्रोटोकॉल का सामुदायिक पूर्वाभ्यास है — एक आधिकारिक `ctx.memory` सीम के लिए उम्मीदवार आकार। यह प्रोटोकॉल इस प्लगइन की सीम को एक क्रॉस-प्लगइन अनुबंध में सामान्य करता है:

- **Entry spec** — दो ट्रैक × दो परतें × प्रति-एजेंट कुंजी, साथ ही छोटे `tags` (≤16 × ≤32 अक्षर) और प्रति-प्रविष्टि `version` जो हर `replace` पर बढ़ता है।
- **Write semantics** — इडेम्पोटेंट अद्वितीय-सबस्ट्रिंग सशर्त लेखन; जो-दिखे-वही-स्वीकृत पेलोड (`replace` / `remove` / `consolidate` बदले जाने वाला पूरा पाठ ले जाते हैं)।
- **Audit contract** — हर लेखन `approval/asked` + `approval/decided` + प्रदाता खाता-बही से पुनर्निर्माण-योग्य।
- **चेतावनी रेखा मॉडल** — परत-वार अक्षर चेतावनी रेखा / `AMBIGUOUS_MATCH` अर्थविज्ञान।
- **Schema versioning** — ज़ोरदार संस्करण जाँच वाले प्रवासन नियम।

- **Spec** — [docs/protocol-v1.md](docs/protocol-v1.md) (中文: [protocol-v1.zh.md](docs/protocol-v1.zh.md)); मानक JSON Schema [docs/schemas/dsh-memory-protocol-v1.schema.json](docs/schemas/dsh-memory-protocol-v1.schema.json) पर।

**Adapter registry** — `ctx.memoryAdapters` (`register` / `list` / `adapt` / `export`) तृतीय-पक्ष मेमोरी प्लगइन को एक शुद्ध डेटा कन्वर्टर पंजीकृत करके प्रोटोकॉल बोलने देता है (उत्क्रमणीय `register()`; आयात अनुमोदन-द्वारी `seed` पर चलता है, निर्यात केवल-पठन है)। ऑनबोर्डिंग: [docs/adapters-guide.md](docs/adapters-guide.md) (中文: [adapters-guide.zh.md](docs/adapters-guide.zh.md))।

| Built-in adapter | External format | Notes |
|---|---|---|
| `mem0` | mem0 तथ्य संग्रह (`{facts: [{memory, metadata?}]}`) | `metadata.category` / `metadata.tags` tags बनते हैं; कच्चे `messages` ऐरे अस्वीकृत — एडेप्टर परिवर्तित करते हैं, कभी निष्कर्षण नहीं |
| `hermes-memory-md` | Hermes `memory.md` (`## section` + बुलेट) | अनुभाग नाम tags बनते हैं; बिना बुलेट वाला गद्य ज़ोर से विफल होता है |
| `claude-code-memory-md` | `CLAUDE.md`-शैली markdown (शीर्षक, बुलेट, अनुच्छेद) | बुलेट और अनुच्छेद प्रविष्टियाँ बनते हैं; अनुभाग नाम tags बनते हैं |

**Conformance suite** — [test/protocol-conformance/](test/protocol-conformance/README.md): एक वितरण-योग्य केस-सेट जिसे संगतता का दावा करने वाला कोई भी प्रदाता चलाता है (`node test/protocol-conformance/run.mjs --provider ./your-factory.mjs`); इस रेपो का CI इसे अपने प्रदाता के विरुद्ध स्वर्ण संदर्भ के रूप में चलाता है (`npm run test:conformance`)।

- **Upstream proposal** — [docs/upstream-proposal.md](docs/upstream-proposal.md) (中文: [upstream-proposal.zh.md](docs/upstream-proposal.zh.md)): आधिकारिक `ctx.memory` सीम को प्रोटोकॉल क्यों अपनाना चाहिए, अंतर और प्रवासन पथ।

## Permissions & data

- **Permissions**: workshop मैनिफ़ेस्ट `harness:tool`, `filesystem:read`, `filesystem:write` और `network:none` / `subprocess:none` / `shell:none` / `python:none` / `credentials:none` घोषित करता है। लेखन अनुमोदन आधिकारिक अनुमोदन सीम पर चलता है।
- **Data**: स्थानीय SQLite डेटाबेस (`0600`), शून्य नेटवर्क, शून्य क्रेडेंशियल।
- **Session log**: ऑडिट पूर्णता अनुमोदन जोड़ी (`approval/asked` + `approval/decided`) और प्लगइन की अपनी ऑडिट तालिका से आती है।

## Security boundaries

- **केवल सार्वजनिक सेवाएँ।** `tools`, `systemPrompt` और अनुमोदन सीम का उपभोग करता है; engine / agent-loop / apiproxy / आधिकारिक UI में कोई बदलाव नहीं।
- **शून्य नेटवर्क, शून्य क्रेडेंशियल।** POSIX फ़ाइल मोड `0600` वाला स्थानीय डेटाबेस।
- **ज़ोर से विफल।** दूषित DB, नया स्कीमा या अमान्य विन्यास लोड पर विफल होता है; भरे बजट और अस्पष्ट सबस्ट्रिंग मिलान संरचित त्रुटियों से विफल होते हैं।
- **एक प्रक्रिया, एक भंडार।** कई सत्र SQLite भंडार साझा करते हैं; एक ही `$DSH_HOME` साझा करने वाली दो प्रक्रियाएँ एक ही फ़ाइल लिखती हैं (SQLite लॉकिंग के तहत अंतिम-लेखक-जीत)।

## Known limitations

- **सत्र घटनाएँ घोषित हैं, अभी उत्सर्जित नहीं (rc.2)।** `memory/added|updated|removed|recalled|snapshot` मर्ज-घोषित हैं, परंतु rc.2 में रेपो-बाहर घटना प्रकारों के लिए कोई पंजीकरण सतह नहीं है; harness बिल्ड उन्हें पंजीकृत करते ही उत्सर्जन चालू हो जाता है।
- **`ask` नीति को answerer चाहिए।** बिना UI/ACP answerer के, लेखन बंद-विफल होते हैं।
- **कोई FTS5 अनुक्रमण नहीं।** सबस्ट्रिंग खोज केस-असंवेदी `instr` पर चलती है (CJK के लिए सही)।
- **अवलोकन एक श्वेतसूची है, और श्वेतसूची की एक सीमा है।** `memory_observe scan` केवल वे `user/message` इवेंट रखता है जिनका `source.kind` `user` या `user-rpc` है; इस मशीन पर मापा गया कि इससे सभी `user/message` इवेंट का 48% हट जाता है (रनटाइम संदर्भ, AGENTS.md, skill सूचियाँ, goal राउंड, सबएजेंट सूचनाएँ)। परन्तु यह किसी व्यक्ति द्वारा लिखे संदेश को उस बाहरी ब्रिज-इंजेक्ट संदेश से अलग नहीं कर सकता जो स्वयं को `kind: 'user'` भी कहता है——लॉग में बस यही एक संकेत है। एक अकेले उद्धरण को कमज़ोर साक्ष्य मानें; निष्कर्ष के लिए सत्रों में पुनरावृत्ति चाहिए।

## What we learned from the terminal memories

`yammory_system` Claude Code, Codex या Hermes का पोर्ट नहीं है — लेकिन इसके डिज़ाइन ने जान-बूझकर वह अपनाया जो प्रत्येक ने सही किया, और वह अस्वीकार किया जो नुकसान करता था:

| Terminal memory | क्या सही किया | yammory_system ने क्या अपनाया |
|---|---|---|
| **Claude Code** — `CLAUDE.md` | पदानुक्रमित सादा-पाठ मेमोरी फ़ाइलें (उपयोगकर्ता-स्तर → परियोजना-स्तर), मानव-पठनीय और संपादन-योग्य, हर सत्र में स्वतः मर्ज | सादा-पाठ प्रविष्टियाँ; `user-global` / `workspace` परतें प्रति-सत्र मर्ज; एक भंडार जिसे आप ब्राउज़, `export` और ऑडिट कर सकते हैं — पारदर्शिता एक विशेषता के रूप में |
| **Codex** — `AGENTS.md` | प्रति-निर्देशिका स्कोप्ड निर्देश स्वतः खोजे और शून्य मॉडल घर्षण से इंजेक्ट | सत्र cwd से अनुक्रमित `workspace` परत (Windows केस-असंवेदी); सत्र आरंभ पर स्वतः इंजेक्ट फ़्रोज़न स्नैपशॉट |
| **Hermes** — `memory.md` | सक्रिय मेमोरी सेव और यह सुरक्षा सबक कि केवल टूल परत पर लागू द्वार देर से टूल-इंजेक्शन से टाला जा सकता है | Save/Skip मार्गदर्शन वाला `memory` टूल + अनुमोदन-द्वारी स्वतः-कैप्चर प्रस्ताव; द्वार `ctx.memory` के लेखन तरीकों के भीतर रहता है, टूल परत में नहीं |

स्रोत: [Claude Code memory](https://code.claude.com/docs/en/memory) · [Codex AGENTS.md](https://developers.openai.com/codex/cli/agents-md) · [Hermes memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md) · [Hermes #48181](https://github.com/NousResearch/hermes-agent/issues/48181)।

और जान-बूझकर अस्वीकार किए गए भाग: मॉडल-निजी स्थिति में छिपा स्व-सारांशीकरण (यहाँ संघनन सारांश **लंबित प्रस्ताव** बनते हैं जो मानव approve/dismiss की प्रतीक्षा करते हैं), भंडार/वेक्टर-स्टोर महत्वाकांक्षाएँ, और बिना मानव-दृश्य अनुमोदन या ऑडिट ट्रेल वाला कोई भी लेखन। यह भी अपनाया गया: Hermes की दस्तावेज़ित चेतावनी कि एक ही होम निर्देशिका साझा करने वाली दो प्रक्रियाएँ एक ही मेमोरी फ़ाइल लिखती हैं — Security boundaries देखें।

## Development

```sh
npm install              # node ^22.19 || >=24
npm test                 # node --test: 141 tests
npm run lint             # oxlint
npm run test:conformance # dsh-memory-protocol v1 conformance suite
npm run typecheck        # tsc --checkJs gate
npm run check:coverage   # line-coverage gate
npm run check:readmes    # five-language README consistency gate
npm run verify:self-contained # reject out-of-repo dependency specs
npm run verify:artifacts # artifact presence + syntax + import
```

`lib/` में शून्य DSH निर्भरता है (केवल node: बिल्टइन); DSH आयात केवल `index.mjs` में मौजूद हैं।

## Topics

`dsh`, `dsh-plugin`, `deepseek-harness`, `memory`, `agent-memory`, `approval`, `audit`, `sqlite`, `cordis`, `llm`

## Contributors

- [@Niuniu-Sir](https://github.com/Niuniu-Sir) — [issue #1](https://github.com/PerryLink/dsh-memento/issues/1) में बूट-क्रैश रिपोर्ट, जिससे 0.3.1 में `~/.dsh` फ़ॉलबैक आया।

## Upstream

This project is a fork of [`dsh-memento`](https://github.com/PerryLink/dsh-memento), originally part of the [PerryLink DSH plugin family](https://github.com/PerryLink). Upstream attribution and the Apache-2.0 licence are preserved.

[Apache License 2.0](LICENSE) © 2026 dsh-memento contributors
