# 판매툴 DB 객체 설계 (중매인 채소 도매)

## 업무 요약

- **중매인**: 도매로 채소를 구매 → 재고 보관 → 판매처에 판매
- **관리 포인트**: 구매처/제품 정보, 재고, 판매처·거래처, 구매일/판매일, 미수금(결제 여부)

---

## 객체(엔티티) 설계

### 1. 거래처 (partners)

구매처·판매처를 통합 관리. 한 거래처가 구매처이면서 판매처일 수 있음.

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| name | string | 거래처명 |
| type | enum | `supplier`(구매처), `customer`(판매처) — 필요 시 둘 다 허용 가능 |
| contact | string | 담당자명 |
| phone | string | 연락처 |
| address | string | 주소 (선택) |
| memo | text | 비고 |
| created_at | timestamp | 등록일시 |
| updated_at | timestamp | 수정일시 |

---

### 2-1. 상품 마스터 (products)

**한정된 품목**만 관리. 채소 종류(배추, 무, 당근 등)처럼 고정된 상품 목록.  
단가는 여기 두지 않음 (경매로 일자별로 달라지므로 별도 테이블에서 관리).

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| name | string | 상품명 |
| unit | string | 단위 (예: kg, 박스, 상자) |
| category | string | 카테고리 (선택) |
| memo | text | 비고 |
| created_at | timestamp | 등록일시 |
| updated_at | timestamp | 수정일시 |

---

### 2-2. 상품별 일별 단가 (product_daily_prices)

**그날 그날 경매/시세** 때문에 금액이 들쑥날쑥하므로, **상품 + 일자** 단위로 단가를 따로 관리.

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| product_id | FK → products | 상품 |
| price_date | date | 기준 일자 (그날 경매/시세) |
| purchase_price | number | 해당 일자 구매 단가 (경매가 등) |
| sale_price | number | 해당 일자 판매 단가 (참고용) |
| memo | text | 비고 (선택) |
| created_at | timestamp | 등록일시 |
| updated_at | timestamp | 수정일시 |

- **유일 제약**: (product_id, price_date) 조합은 하루에 1건만. 같은 상품이라도 날짜마다 다른 단가 저장.
- 구매/판매 입력 시: 해당 일자의 `product_daily_prices` 를 참고해서 단가를 자동 채우거나, 직접 입력한 단가로 저장.

---

### 3. 구매 (purchases) — 입고

도매 구매 시 기록. 입고 시 재고 증가.

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| partner_id | FK → partners | 구매처(공급처) |
| product_id | FK → products | 상품 |
| quantity | number | 수량 |
| unit_price | number | 단가 |
| total_amount | number | 총 금액 (quantity × unit_price 또는 직접 입력) |
| purchase_date | date | 구매일 |
| memo | text | 비고 |
| created_at | timestamp | 등록일시 |
| updated_at | timestamp | 수정일시 |

---

### 4. 판매 (sales) — 출고

판매처에 판매 시 기록. 출고 시 재고 감소. **손해 보며 판매**하는 경우도 있음 (단가를 원가보다 낮게 입력).

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| partner_id | FK → partners | 판매처(거래처) |
| product_id | FK → products | 상품 |
| quantity | number | 수량 |
| unit_price | number | 판매 단가 (손해면 원가보다 낮게 입력) |
| cost_at_sale | number | (선택) 판매 시점 원가. 있으면 화면에서 손익·손해 표시 가능 |
| total_amount | number | 총 금액 (quantity × unit_price 등) |
| sale_date | date | 판매일 |
| payment_status | enum | `paid`(완료), `unpaid`(미수), `partial`(일부 수금) |
| paid_amount | number | 수금 누계 (수금 배분 시 갱신, 아래 payments/allocations 반영) |
| memo | text | 비고 |
| created_at | timestamp | 등록일시 |
| updated_at | timestamp | 수정일시 |

**미수금(건별)**: `total_amount - paid_amount`. **수금**은 한 건씩이 아니라 **여러 sales를 묶어서 일부 금액만 결제**할 수 있으므로, 아래 `payments` + `payment_allocations` 로 관리.

---

### 4-2. 수금 (payments) — 묶음 결제

거래처가 **한 번에 받은 금액**을 기록. “이번에 50만 원 받음”처럼.

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| partner_id | FK → partners | 수금한 거래처(판매처) |
| amount | number | 수금 총액 |
| paid_at | date | 수금일 |
| memo | text | 비고 |
| created_at | timestamp | 등록일시 |

---

### 4-3. 수금 배분 (payment_allocations)

한 번의 수금(payment)을 **여러 판매 건(sales)에 나눠서 배분**.

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| payment_id | FK → payments | 수금 건 |
| sale_id | FK → sales | 판매 건 |
| amount | number | 이 판매 건에 배분한 금액 |

- 한 `payment`에 여러 `payment_allocations` (여러 sale에 배분).
- 각 sale의 `paid_amount` = 해당 sale에 대한 allocations 합계. 배분 추가/삭제 시 `sales.paid_amount` 갱신.

---

### 5. 폐기 (disposals) — 재고 감소(매출 없음)

판매하지 못하고 **폐기**한 경우. 재고만 줄고, 매출·거래처 없음.

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| product_id | FK → products | 상품 |
| quantity | number | 폐기 수량 |
| disposal_date | date | 폐기일 |
| reason | string | 사유 (선택, 예: 유통기한, 품질) |
| memo | text | 비고 |
| created_at | timestamp | 등록일시 |
| updated_at | timestamp | 수정일시 |

- **재고 반영**: 해당 상품 `inventory.quantity` 에서 **quantity 만큼 감소** (판매와 동일하게 차감).

---

### 6. 재고 (inventory)

상품별 현재 재고 수량. 구매 시 증가, 판매 시 감소. 실사/조정 시 수동 반영 가능.

| 속성 | 타입 | 설명 |
|------|------|------|
| id | UUID / serial | PK |
| product_id | FK → products | 상품 (유일 1건만) |
| quantity | number | 현재 수량 (0 이상) |
| updated_at | timestamp | 마지막 반영 일시 |

- 상품당 1행만 유지 (UPSERT 방식).
- **재고 감소 요인**: 판매(sales), 폐기(disposals). 구매(purchases)는 증가만.

---

### 7. 상품 이동 이력 (product_transfers) — Tracking 필수

**구매·판매·폐기 시마다 무조건 1건** 등록. **몇 시에 어디에서 어디로** 이동했는지 추적.

| 속성 | 타입 | 설명 |
|------|------|------|
| id | serial | PK |
| product_id | FK → products | 상품 |
| quantity | number | 이동 수량 |
| from_type | enum | 출발: `supplier`(구매처), `inventory`(재고), `customer`(거래처), `disposal`(폐기) |
| to_type | enum | 도착: 동일 enum |
| from_partner_id | FK → partners (nullable) | 출발이 구매처/거래처일 때 |
| to_partner_id | FK → partners (nullable) | 도착이 구매처/거래처일 때 |
| transferred_at | timestamptz | **이동 시각** (몇 시) |
| purchase_id | FK → purchases (nullable) | 구매로 인한 이동이면 |
| sale_id | FK → sales (nullable) | 판매로 인한 이동이면 |
| disposal_id | FK → disposals (nullable) | 폐기로 인한 이동이면 |
| memo | text | 비고 |
| created_at | timestamp | 등록일시 |

**이동 패턴 (무조건 기록)**  
- **구매**: 구매처 → 재고 (`from_type=supplier`, `to_type=inventory`, `from_partner_id=구매처`, `purchase_id` 설정)  
- **판매**: 재고 → 거래처 (`from_type=inventory`, `to_type=customer`, `to_partner_id=판매처`, `sale_id` 설정)  
- **폐기**: 재고 → 폐기 (`from_type=inventory`, `to_type=disposal`, `disposal_id` 설정)  

구현 시: purchases/sales/disposals INSERT 시 **같은 트랜잭션에서 product_transfers 에 1건 INSERT** 하거나, DB 트리거로 자동 등록.

---

## 관계 요약

```
partners (구매처/판매처)
  ↑                    ↑
  |                    |
purchases            sales ←—— payment_allocations ——→ payments
  |                    |              (묶음 수금 배분)
  +→ product_id ←------+
         ↓
     products (상품 마스터, 한정)
         ↓
  product_daily_prices (상품별·일별 단가)
  disposals (폐기) ——→ inventory (product당 1행)
  product_transfers: 구매/판매/폐기마다 1건 (어디→어디, transferred_at)
```

- **재고**: 구매로 증가, 판매·폐기로 감소. `inventory.quantity` = 구매 합계 − 판매 합계 − 폐기 합계 (+ 조정).
- **이동 이력**: 모든 입출고는 `product_transfers` 에 기록. `transferred_at` 으로 시각 추적, `from_type`/`to_type` 으로 구간 표시 (구매처→재고, 재고→거래처, 재고→폐기).
- **미수금**: `sales.paid_amount` = 해당 sale에 대한 `payment_allocations` 합계. 묶음 수금은 payments + payment_allocations 로 배분.
- **손해 판매**: sales.unit_price가 cost_at_sale보다 작으면 손해. 화면에서 원가 대비 표시.

---

## 확장 시 고려

- **창고/위치**: 재고를 창고별로 나누려면 `inventory`에 `warehouse_id` 추가.
- **거래처 타입**: 한 거래처가 구매처+판매처면 `partner_types` 배열 또는 별도 관계 테이블로 확장 가능.

이 설계를 기준으로 PostgreSQL 테이블 DDL을 `schema.sql` 에 작성해 두겠습니다.
