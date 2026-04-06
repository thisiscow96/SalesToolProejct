# 🚀 Sales Tool Project

> 영업/재고/수금/폐기 프로세스를 통합하여  
> 반복 입력과 데이터 분산 문제를 해결한 실무형 판매 관리 시스템

---

## 🔍 Overview

기존 판매 관리 툴은 매입/매출/수금/폐기 데이터가 분산되어 있고,  
반복 입력이 많아 실사용자의 업무 피로도가 높은 상태였습니다.

이를 해결하기 위해 **업무 흐름을 하나의 체계로 통합하고,  
운영 가능한 구조로 재설계 및 구현**했습니다.

---

## ⚡ Key Improvements

- 반복 입력 제거 및 업무 흐름 단순화
- 매입/매출/수금/폐기 데이터 통합 관리
- 운영 이력 추적 가능 구조 구축
- 사용자 입력 편의성(UI/UX) 개선

---

## 🔄 Before vs After

### Before

- 매입/매출/수금 데이터가 각각 분산 관리됨
- 동일 데이터 반복 입력 발생
- 변경 이력 관리 부재로 유지보수 어려움
- 커뮤니케이션 의존도가 높아 오류 발생

### After

- 업무 흐름(재고·매입·매출·수금·폐기) 통합 관리
- 입력 단계 최소화 및 사용자 중심 UI 개선
- 변경 이력 추적 가능한 운영 구조 구축
- 데이터 기반 관리 및 운영 신뢰도 향상

---

## 🛠 Solution

### 1. 시스템 아키텍처 구성

- Backend: Node.js (Express)
- Frontend: React (Vite)
- Database: PostgreSQL

### 2. 운영 배포 체계 구축

- GitHub 기반 형상관리
- Render (Backend) / Vercel (Frontend) 배포
- 운영 이력(배포 로그) 관리 체계 구성

### 3. 개발 프로세스 개선 (Agent 활용)

- 분석 → 설계 → 구현 → 검증 → 문서화 자동화 루프 구축
- 규칙 기반 개발 환경([`.cursor/rules`](.cursor/rules)) 적용
- 품질 기준(입력 가시성, 문서화 등) 일관성 유지

---

## 💡 Key Features

- **매입/매출/수금/폐기 통합 관리 UI**
  - 모달 기반 입력 구조 개선
  - 입력값 가시성 및 반응형 UI 개선

- **수금 관리 기능 고도화**
  - 미수금 초과 방지 로직 적용
  - 날짜 및 입력 UX 개선

- **폐기 관리 프로세스 개선**
  - 기간 기반 조회 (From ~ To)
  - 처리 대상 선택 및 검증 흐름 정리

- **운영 문서 체계 구축**
  - 사용자 매뉴얼 / 배포일지 / Docs 구조화
  - 변경 이력 추적 가능 구조

---

## 📈 Impact

- 실사용자 기준 입력/조회 편의성 향상
- 반복 작업 감소로 업무 피로도 완화
- 데이터 흐름 정리로 운영 신뢰도 개선
- 배포 및 변경 이력 관리로 유지보수 효율 향상

---

## 🧑‍💻 My Role

- 요구사항 분석 및 업무 프로세스 재정의
- 시스템 아키텍처 설계 (DB / API / UI 구조)
- Backend / Frontend 개발 및 배포
- 사용자 피드백 기반 UI/UX 개선
- 운영 문서 및 배포 관리 체계 구축

👉 End-to-End (분석 → 설계 → 개발 → 배포 → 운영) 수행

---

## 📌 Status

- 핵심 기능 구현 완료
- 실사용자 기반 운영 테스트 진행 중
- 지속적인 개선 및 안정화 진행

---

## 📷 Screenshots
> 사용자 메뉴얼 링크
> [`[.cursor/rules](https://github.com/thisiscow96/SalesToolProejct/blob/main/docs/90.%20%EB%A9%94%EB%89%B4%EC%96%BC%20%EA%B4%80%EB%A6%AC/%EB%A7%A4%EB%89%B4%EC%96%BC/%EC%9A%B4%EC%98%81%EC%9E%90-%EC%82%AC%EC%9A%A9%EC%9E%90-%EB%A7%A4%EB%89%B4%EC%96%BC.md)`](사용자 메뉴얼 링크)
> ([`https://github.com/thisiscow96/SalesToolProejct/blob/main/docs/90.%20%EB%A9%94%EB%89%B4%EC%96%BC%20%EA%B4%80%EB%A6%AC/%EB%A7%A4%EB%89%B4%EC%96%BC/%EC%9A%B4%EC%98%81%EC%9E%90-%EC%82%AC%EC%9A%A9%EC%9E%90-%EB%A7%A4%EB%89%B4%EC%96%BC.md`](.cursor/rules))

---

## 🧩 Tech Stack

- React (Vite)
- Node.js (Express)
- PostgreSQL
- Render / Vercel
- GitHub

---
