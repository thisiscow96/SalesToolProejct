# 매뉴얼용 PNG 자리표시 이미지 생성 (실제 스크린샷 아님 — 배포 전 교체 권장)
# 실행: PowerShell에서 docs/매뉴얼/scripts 위치로 이동 후 .\Generate-PlaceholderImages.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$imagesDir = Join-Path $PSScriptRoot "..\images" | Resolve-Path
$items = @(
    @{ File = "00-main-layout.png";        Title = "1. 로그인 후 메인 화면";           Sub = "탭 · 헤더 · 본문 영역" }
    @{ File = "01-inventory.png";          Title = "2. 재고현황 탭";                 Sub = "상품 · 매입처 · 수량 · 매입일" }
    @{ File = "02-purchases-list.png";     Title = "3. 매입정보 — 목록·필터";         Sub = "기간 · 제품 · 검색 · 매입등록 · 매출전환" }
    @{ File = "02-purchases-modal-register.png"; Title = "3. 매입 등록 모달";    Sub = "행추가 · 복제 · 매입처 · 상품 · 수량 · 단가" }
    @{ File = "02-purchases-modal-convert.png";  Title = "3. 선택 매출 전환 모달"; Sub = "판매처 · 매출일 · 수량·단가" }
    @{ File = "03-sales-list.png";        Title = "4. 매출정보 — 목록";            Sub = "수금등록 · 환불처리 버튼" }
    @{ File = "03-sales-modal-collect.png"; Title = "4. 수금 등록 모달";           Sub = "거래처 · 미수 배분 · 이번수금(숫자9자리)" }
    @{ File = "03-sales-modal-refund.png"; Title = "4. 환불 처리 모달";            Sub = "거래처검색 · 사유통일 · 환불요청수량" }
    @{ File = "04-payments.png";          Title = "5. 수금정보 탭";                 Sub = "기간 · 거래처 · 수금/환불 구분" }
    @{ File = "05-disposals-list.png";    Title = "6. 폐기정보 — 목록";             Sub = "기간 · 폐기등록" }
    @{ File = "05-disposals-modal.png";   Title = "6. 폐기 등록 모달";             Sub = "재고검색 · 체크 · 사유픽리스트" }
    @{ File = "06-product-master.png";    Title = "7. 상품 마스터 (관리자)";       Sub = "검색 · 새로만들기" }
)

$fontHead = New-Object System.Drawing.Font "Malgun Gothic", 13, [System.Drawing.FontStyle]::Bold
$fontTitle = New-Object System.Drawing.Font "Malgun Gothic", 18, [System.Drawing.FontStyle]::Bold
$fontSub = New-Object System.Drawing.Font "Malgun Gothic", 11
$fontHint = New-Object System.Drawing.Font "Malgun Gothic", 8.5
$w = 960
$h = 540

foreach ($it in $items) {
    $path = Join-Path $imagesDir $it.File
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(248, 250, 252))

    # 상단 바 (슬레이트 톤)
    $brushBar = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255))
    $g.FillRectangle($brushBar, 0, 0, $w, 52)
    $penLine = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(226, 232, 240))
    $g.DrawLine($penLine, 0, 52, $w, 52)
    $brushBrand = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(51, 65, 85))
    $g.DrawString("판매툴 — 매뉴얼 삽화 (자리표시)", $fontHead, $brushBrand, 20, 14)

    # 본문 영역 (가짜 카드)
    $penCard = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(226, 232, 240), 1)
    $g.DrawRectangle($penCard, 24, 72, $w - 48, $h - 72 - 56)
    $brushMain = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, 41, 59))
    $g.DrawString($it.Title, $fontTitle, $brushMain, 48, 96)
    $brushSub = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(71, 85, 105))
    $g.DrawString($it.Sub, $fontSub, $brushSub, 48, 142)

    $brushFoot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(148, 163, 184))
    $foot = "자동 생성 이미지 · 실제 서비스 화면과 다를 수 있음 · 교체: " + $it.File
    $g.DrawString($foot, $fontHint, $brushFoot, 24, ($h - 36))

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "OK $path"
}

Write-Host "Done. Count: $($items.Count)"
