# Sales Tool Project

> 영업/재고/수금/폐기 프로세스를 통합하여 반복 입력과 데이터 분산을 줄이기 위한 **실무형 판매 관리** 시스템입니다.

---

## 🎯 Highlight

본 프로젝트는 요구사항 분석부터 설계, 개발, 배포까지 **End-to-End로 수행한 대표 프로젝트**입니다.

**스토리·문제 정의·Solution·구현 요약·Impact·회고**는 모두 [`docs/0. 프로젝트 목적/`](docs/0.%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8%20%EB%AA%A9%EC%A0%81/README.md) 에서 이어서 읽을 수 있습니다. (이 README는 **한눈에만** 보여 줍니다.)

---

## Overview

- 기존에는 매입/매출/수금/폐기 데이터가 흩어지고, 반복 입력·이력 부재로 운영 리스크가 있었습니다.
- 업무 흐름을 **하나의 체계**로 묶고, **추적 가능한** 문서·배포 구조까지 포함해 구현했습니다.

---

## Key Improvements

- 반복 입력 감소 및 업무 흐름 단순화
- 매입/매출/수금/폐기 데이터 통합 관리
- 운영 이력 추적 가능 구조
- 입력 편의성(UI/UX) 개선

---

## Before vs After

| Before | After |
|--------|--------|
| 데이터 분산·반복 입력 | 통합 흐름·입력 단계 축소 |
| 변경 이력 관리 어려움 | 배포·설계·진척 문서로 추적 |
| 커뮤니케이션 의존 | 데이터·로그 기반 운영 |

---

## Impact

- 입력/조회 편의성 개선
- 반복 작업 감소
- 운영 이력 관리로 유지보수 효율 향상

---

## My Role

요구사항 분석, 아키텍처·DB·UI 설계, 백엔드/프론트 구현, 배포, 운영 문서화까지 **End-to-End**로 수행했습니다.

---

## Screenshots

대표 화면(메인 / 모달 입력). 전체 기능별 캡처는 [사용자 매뉴얼](docs/90.%20%EB%A9%94%EB%89%B4%EC%96%BC%20%EA%B4%80%EB%A6%AC/%EB%A7%A4%EB%89%B4%EC%96%BC/%EC%9A%B4%EC%98%81%EC%9E%90-%EC%82%AC%EC%9A%A9%EC%9E%90-%EB%A7%A4%EB%89%B4%EC%96%BC.md)을 참고하세요.

![메인 화면](./docs/images/main.png)

![모달 입력 예시](./docs/images/modal.png)

---

## Tech Stack

React (Vite) · Node.js (Express) · PostgreSQL · Render / Vercel · GitHub

---

## 더 읽기 · 코드 위치

| | |
|--|--|
| **스토리 문서** | [`docs/0. 프로젝트 목적/`](docs/0.%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8%20%EB%AA%A9%EC%A0%81/README.md) |
| **문서 허브(00~99, 매뉴얼, 배포)** | [`docs/README.md`](docs/README.md) |
| **코드** | [`web/`](web/) (프론트) · [`server/`](server/) (API) · [`mobile/`](mobile/) — 레포는 **모노레포**이며 `backend/`·`frontend/` 폴더명은 사용하지 않습니다. |

- 연동 이력: [docs/00. 프로젝트 관리/연동-이력.md](docs/00.%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8%20%EA%B4%80%EB%A6%AC/%EC%97%B0%EB%8F%99-%EC%9D%B4%EB%A0%A5.md)
- Object 설계 · DDL: [docs/10. 포로젝트 분석설계/object 설계서/](docs/10.%20%ED%8F%AC%EB%A1%9C%EC%A0%9D%ED%8A%B8%20%EB%B6%84%EC%84%9D%EC%84%A4%EA%B3%84/object%20%EC%84%A4%EA%B3%84%EC%84%9C/) · [`server/schema.sql`](server/schema.sql)
- 배포일지: [docs/99. 배포관리/배포/배포일지/](docs/99.%20%EB%B0%B0%ED%8F%AC%EA%B4%80%EB%A6%AC/%EB%B0%B0%ED%8F%AC/%EB%B0%B0%ED%8F%AC%EC%9D%BC%EC%A7%80/)
- 개발 규칙(AI): [`.cursor/rules/`](.cursor/rules/)

클론 후 환경 변수: [`docs/20. 프로젝트 개발준비/환경 변수설정/`](docs/20.%20%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8%20%EA%B0%9C%EB%B0%9C%EC%A4%80%EB%B9%84/%ED%99%98%EA%B2%BD%20%EB%B3%80%EC%88%98%EC%84%A4%EC%A0%95/README.md)
