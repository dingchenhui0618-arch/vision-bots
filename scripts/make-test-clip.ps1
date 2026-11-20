param([string]$Dir = 'D:/Projects/ds-media-studio/.test', [string]$Ffmpeg)

$n = 5
$filter = ''
for ($i = 0; $i -lt $n; $i++) { $filter += "[$($i):a]aresample=48000[a$($i)];" }
$concat = ''
for ($i = 0; $i -lt $n; $i++) {
  $concat += "[a$($i)]"
  if ($i -lt $n - 1) {
    $filter += "anullsrc=r=48000:cl=mono[d$($i)];"
    $filter += "[d$($i)]atrim=0:1.1[s$($i)];"
    $concat += "[s$($i)]"
  }
}
$filter += $concat + "concat=n=9:v=0:a=1[out]"

$ffargs = @('-y','-loglevel','error')
for ($i = 0; $i -lt $n; $i++) { $ffargs += @('-i', (Join-Path $Dir "tts_$($i).wav")) }
$ffargs += @('-filter_complex', $filter, '-map', '[out]', '-c:a', 'pcm_s16le', (Join-Path $Dir 'speech.wav'))
& $Ffmpeg @ffargs

& $Ffmpeg -y -loglevel error -i (Join-Path $Dir 'speech.wav') -f lavfi -i 'color=c=0x1a1a1e:s=1080x1920:r=30' -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 128k (Join-Path $Dir 'talk.mp4')
Write-Output ('talk: ' + [math]::Round((Get-Item (Join-Path $Dir 'talk.mp4')).Length/1KB,1) + 'KB')
