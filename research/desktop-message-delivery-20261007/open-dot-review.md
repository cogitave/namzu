# Open Dot: kaynak incelemesi ve Namzu için yararlı fikirler

İnceleme: **2026-10-07**, salt okunur. GitHub API’nin `main` için verdiği son
commit **`f838e17cf5c3a88ade5ceea54680a8145d048c1d`**, author/committer tarihi
**2026-09-30 13:08:56 UTC**. Aşağıdaki dış bağlantılar bu commit’e sabittir.
[Commit](https://github.com/composio-community/open-dot/commit/f838e17cf5c3a88ade5ceea54680a8145d048c1d).

README’nin ötesinde Electron başlangıcı, agent döngüsü, SQLite repository,
event/store, sohbet, dosyalar, bilgisayar, scheduler ve action kaynakları okundu.
Uygulama kurulmadı veya çalıştırılmadı; kaynak davranışı, gerçek kullanımda
başarılı çalıştığı iddiası değildir. Namzu karşılaştırması mevcut çalışma ağacına
ve `docs/cli/{desktop,acp,delegated-work,pals}.md` belgelerine dayanır; taban commit
`0a76c1d07ab33c8102b4f7785907d32e63bf593b`. Bu turdaki canlı giriş düzeltmesinin
yerel kontrollü testleri ile henüz devam eden native karşılaştırma ayrı kanıtlardır.

## Gerçekte nasıl kurulmuş?

| Katman | Open Dot’ta doğrulanan uygulama | Namzu’da karşılığı |
| --- | --- | --- |
| Desktop | Electron, loopback Next.js server çocuğunu başlatır; pencere HTTP uygulamasını gösterir. | Electron main → canonical proje başına CLI ACP çocuğu → SDK. Renderer ikinci agent döngüsü kurmaz. |
| State | SQLite kalıcı mesaj/thread/pending-card durumunu tutar; çalışma ve inbox `globalThis` Map’lerindedir. SSE bağlanınca snapshot, sonra değişiklikler gelir. | Hash zincirli session journal asıl kayıt; SQLite yeniden kurulabilir index. Main sahiplik ve revision kontrolünü, renderer görünümü tutar. |
| Computer | Cloud E2B desktop veya local/container komutları ve ayrı persistent Chromium. | Pal’ın sahipli guest runtime’ı, computer generation/control lease ve ayrı host erişim sınırı. |

Kaynaklar: [Electron](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/electron/main.mjs#L39),
[DB](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/db.ts#L48),
[SSE](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/app/api/events/route.ts#L5),
[computer dispatch](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/computer/index.ts#L10).
Namzu: `packages/desktop/src/main/index.ts`, `main/operator.ts`,
`packages/cli/src/commands/desktop-host.ts`, `docs/sdk/session-log.md`.

## Şu anki mesaj sorunumuz açısından sonuç

Open Dot `sendMessage` ile user satırını hemen kaydeder, girdiyi **ajan başına**
inbox’a ekler. `pump`, `running` durumunda döner; `withRun.finally` sonraki işi
başlatır. Mevcut işe mesaj enjekte eden/wait’i uyandıran bir kanal bulunmadı.
Aynı hedefe giden bitişik girdiler bir sonraki run için birleştirilir.
[Agent runtime](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/agent/runtime.ts#L42).

Dolayısıyla bunu kopyalamak bekleyen `wait_for_task` sorununu çözmez. Namzu’nun
yeni `inboundMessages`/`waitForInbound` bağlantısı aynı çocuk çalışırken ebeveyni
uyandırıyor; scope/input ID ve pending/delivered kayıtları belirsiz ACK’yi ayırıyor.
Mevcut kaynaklar: `commands/acp.ts:332`, `commands/desktop-host.ts:512`,
`integrations/subagents/runtime.ts:1244`, `desktop/main/operator.ts:2331`.
Kontrollü kanıt: `commands/__tests__/acp-live-input.test.ts` ve
`integrations/subagents/__tests__/operator-input-releases-delegation.test.ts`.

## Alınabilecek dört somut fikir

### 1. Pal’ın dosya teslimini sohbet içinde gerçek bir çıktı olarak sunmak

Open Dot’un `share_file` aracı guest dosyasını kalıcı uygulama kopyasına alıyor;
mesaja attachment ekliyor. Chat bunun önizleme/indirme bağlantısını gösteriyor.
[Tool](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/agent/tools.ts#L79),
[file store](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/files.ts#L31),
[chat attachment](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/components/Chat.tsx#L315).

Namzu dosya/araç içeriğini ve kullanıcı attachment’larını zaten taşır. Ancak
`renderer/app.tsx:2601` Pal Outputs listesini yalnız değişen dosya sayısı ve
ChangesPanel’den kuruyor; guest’in ürettiği oyun/model/PDF için bu, teslim edilmiş
indirilebilir artifact değildir. En yararlı sonraki ürün işi budur.

**Dar tasarım:** Gerçek, sahipliği doğrulanmış çıktı referansı + isim/media/size;
renderer keyfi path veremez. Guest/provider izinleri, byte limiti, immutable
kopya ve tekrar açılış tasarlanmalı. Mevcut transient `AttachmentView.id` için
olmayan bir okuma API’si varmış gibi davranılmamalı. **Kanıt:** çıktı üretip
paylaşma → yeniden açma → exact bytes; başka Pal erişimi, eksik dosya ve oversize
refusal. Önizleme retirement provider/durable bytes’ı değiştirmemeli.

### 2. Başka sohbette gelen sonuç ve onay için sessiz dikkat işareti

Open Dot chat dönüşünde yeni içerik ayracı gösteriyor; store görünmeyen ajan
mesajlarını toast/notification ile duyurabiliyor.
[Chat](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/components/Chat.tsx#L54),
[client store](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/lib/store.ts#L146).

Namzu’da başka sohbetin **çalışan background process** göstergesi zaten var
(`main/background-work-status.ts`, `docs/cli/desktop.md` Background work).
Bu, okunmamış cevap veya bekleyen insan kararı göstergesi değildir.

**Dar tasarım:** Tam conversation owner + admitted message/review ID üzerinden
okunmamış işaret ve isteğe bağlı completion bildirimi. Token başına bildirim yok;
aktif görünen sohbet için gereksiz toast yok. Open Dot’taki dot-wide timestamp
yerine session/sequence kullanmak daha doğru. **Kanıt:** iki sohbet, iki pencere,
navigation ve reconnect; aynı completion bir kez, geç snapshot eski unread’i
diriltmez, başka sohbeti okumuş saymaz.

### 3. Planlı işlerin kaynağını kullanıcıya göstermek

Open Dot routine/trigger işi için ayrı conversation seçer; başlangıç mesajında
işin kaynağını belirtir. Böylece kullanıcı bir mesajın neden geldiğini görür.
[Routine/trigger entry points](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/agent/runtime.ts#L86),
[conversation reuse](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/repo.ts#L140).

Namzu’da scheduling/resident ve durable delivery zaten bulunuyor
(`docs/cli/scheduled-tasks.md`, `scheduler-service.md`, `resident-runner.md`);
yeni scheduler gerekmiyor. **Dar tasarım:** Mevcut doğrulanmış origin bilgisini
sohbet başlığında veya delivered Pal mesajının küçük kaynağında göstermek.
Modelin yazdığı “routine” metni authority olamaz. **Kanıt:** aynı task’ın farklı
run’ları, teslim tekrarları, eksik legacy provenance ve başka Pal kaynağı; normal
arkadaş sohbeti teknik execution log’una dönmemeli.

### 4. Pencereyi kapatmak ile uygulamadan çıkmayı açık ayırmak

Open Dot macOS close sırasında pencereyi gizler; server çalışmaya devam eder.
Gerçek quit server’a SIGTERM gönderir.
[Lifecycle](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/electron/main.mjs#L132).

Namzu’nun Windows/Linux son pencere kapanışı kasıtlı olarak owned runtime
temizliği yapar (`main/index.ts:808`); macOS zaten uygulamayı açık tutar. **Olası
ürün tercihi:** Windows’ta açıkça seçilen “arka planda açık tut”/tray davranışı.
Mevcut kapatma varsayılanı sessizce değiştirilmemeli. Bu, UI navigation dışında
arka plan işlerinin ömrünü anlatmayı da gerektirir. **Kanıt:** hide/show runtime
aynı; açık Quit parent/children/guest cleanup’ı bekler; cleanup failure sahipliği
korur; tekrar açma ikinci runtime veya ikinci iş üretmez.

## Kopyalanmaması gereken sınırlar

- Open Dot boot, kayıtlı working durumunu idle/waiting’e çevirir; bellekteki inbox
  restart sonrası geri kurulmaz. Bu, durable pending-input/replay kanıtı değildir.
  [Boot](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/boot.ts#L10).
- Chat çalışma sahibini en son aktif conversation’dan tahmin eder; activity
  satırı araç başlamadan kaydedilir ve tek başına başarılı tamamlanma kanıtlamaz.
  Namzu’nun exact call/owner, Interrupted/Cancelled ve yalnız delivered Pal
  mesajları yaklaşımı korunmalı. `renderer/tool-transcript-presentation.ts`,
  `shared/history-work.ts`, `renderer/pal-chat-transcript.tsx` zaten bunu yapıyor.
- Takeover önce ajanı pause/abort eder; ardından bilgisayarı verir. Cloud ve local
  input yolları farklıdır. UI’daki düğme tek başına güncel lease/fence garantisi
  değildir. Namzu’nun current computer generation, held-key release ve owning
  runtime doğrulamaları korunmalı.
  [Takeover action](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/app/actions.ts#L149).
- Open Dot local moda “sandbox folder” dese de shell fallback hostta Bash
  çalıştırır; bu bir işletim sistemi izolasyonu değildir. Namzu’nun Pal guest’i
  ve host erişimi bu moda indirgenmemeli.
  [Shell fallback](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/computer/shell.ts#L54).

Öncelik önerisi: **canlı mesaj iletimini bitir → gerçek dosya teslimi →
okunmamış sonuç/insan kararı işareti**. Planlı iş kaynağı ve tray davranışı ayrı,
daha sonra değerlendirilecek ürün işleri. Bu incelemede üretim kaynağı değişmedi.
