# ArtificialAnalysis — how the encrypted manifest was found (full step-by-step)

This is the complete process used to recover the deploy-ahead data from ArtificialAnalysis. Only the official site was used. Tools: `curl`, system Node.js, in-memory analysis. No installs, no cookies, no third-party catalogs.

## 1. Why this target

ArtificialAnalysis publishes model benchmark data on its homepage. The useful signal would be a hidden dataset containing models/slugs that are not yet shown publicly — a manifest that updates before the public page. So the goal was to find the site's internal data payload, not the visible catalog.

## 2. Fetch the homepage

```
curl.exe -A "Mozilla/5.0" -L -s "https://artificialanalysis.ai/" -o homepage.html
```

The response is a Next.js RSC (React Server Component) payload. The visible model list is in a public `initialData` array, but the interesting part is what is embedded alongside it.

## 3. Find the embedded manifest pointer

Unescape the payload first (`\"` → `"`, `\\` → `\`), then regex for a data path and key:

```python
u = html.replace('\\"', '"').replace('\\\\', '\\')
m = re.search(r'"path":"(/data/[^"]+\.txt)","key":"([0-9a-f]+)"', u)
```

Found:
```
path = /data/324ed05c14a0dc8b.txt
key  = b768dbf9e59daf6223a1f139ffe24942dcf292d668787249d78018edde76a011
```

This means the site ships an encrypted dataset plus the key needed to read it — the exact kind of deploy-ahead artifact being hunted.

## 4. Download the encrypted binary

```
curl.exe -A "Mozilla/5.0" -L -s "https://artificialanalysis.ai/data/324ed05c14a0dc8b.txt" -o manifest.bin
```

Result: `200`, 76,058 bytes of binary ciphertext. Not plain JSON, not plain gzip — it needs the site's own decoder.

## 5. Locate the decoder chunk

The decoder lives in the site's JavaScript. Steps:

1. Extract every `<script src="...js">` from the homepage.
2. Fetch all of those chunks.
3. Grep each for both `DecompressionStream` and `AES-GCM`.

The matching chunk was:
```
https://artificialanalysis.ai/_next/static/chunks/76089-0626492c1c87ff91.js
```

That combination — AES-GCM plus gzip stream — reveals the whole decryption pipeline.

## 6. Reverse engineer the algorithm

From the decoder routine:

```
1. hex key  -> bytes (Uint8Array.from(hex.match(/../g).map(x=>parseInt(x,16))))
2. IV       = first 12 bytes of SHA-256(keyBytes)
3. decrypt  = WebCrypto AES-GCM, tagLength 128, using keyBytes + IV
4. plain    = gzip decompress the decrypted bytes (DecompressionStream("gzip"))
5. data     = JSON.parse(decompressed text)
```

Why each step matters:
- The key is embedded in the page, so the browser can decrypt on the fly.
- Deriving the IV from the key's SHA-256 means no separate IV is transmitted.
- Gzip shrinks the payload before encryption; AES-GCM provides integrity, so a wrong key fails loudly.

## 7. Decrypt

Node decryptor (run in memory / from a single script at the time):

```js
const fs=require("fs");
const crypto=require("crypto").webcrypto;
(async()=>{
  const info=fs.readFileSync("manifest_info.txt","utf8");
  const key=info.match(/key:\s*([0-9a-f]+)/)[1];
  const bytes=Uint8Array.from(key.match(/../g).map(x=>parseInt(x,16)));
  const iv=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes.buffer)).slice(0,12);
  const ct=new Uint8Array(fs.readFileSync("manifest.bin"));
  const k=await crypto.subtle.importKey("raw",bytes,{name:"AES-GCM"},false,["decrypt"]);
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv,tagLength:128},k,ct);
  const ds=new DecompressionStream("gzip");
  const w=ds.writable.getWriter(); w.write(new Uint8Array(plain)); w.close();
  const txt=await new Response(ds.readable).text();
  fs.writeFileSync("manifest.json",txt);
})();
```

Output: 395,304 bytes of JSON — the full hidden dataset.

## 8. Parse and diff against public data

- Parse the JSON: 999 endpoint records.
- Unique `modelSlug` values: 399.
- Public homepage `initialData` slugs: 29.
- Novel slugs present in the manifest but absent from the public homepage: 373.

The diff is what makes this a deploy-ahead signal: those 373 slugs exist in the shipped internal data before the public catalog shows them.

## 9. Result

The encrypted manifest is the only working early-signal artifact recovered. Arena.ai was checked deeply as an alternative but had no equivalent encrypted manifest — every model-bearing surface returned the same post-release catalog — so ArtificialAnalysis remains the usable source.

## 10. Refresh recipe (for future 1–2 hour lead time)

```
1. GET https://artificialanalysis.ai/            -> extract new path + key
2. GET https://artificialanalysis.ai<path>        -> new encrypted binary
3. run the AES-GCM + gzip decrypt                  -> new JSON
4. diff modelSlug set against previous snapshot    -> new slugs = deploy-ahead signal
```

Poll the homepage, watch for a new `path`/`key`, and any slug that appears in the decrypted manifest before the public blog/catalog update is the signal.
