# Goong Road Editor

Editor nay dung giao dien iD de doc va cap nhat truc tiep bang duong trong PostGIS thong qua mot OSM API adapter. Browser khong ket noi thang vao PostgreSQL.

Luong ket noi mac dinh:

```text
Browser http://127.0.0.1:8081
  -> Node OSM API adapter trong container editor_goong:8080
  -> PostGIS host.docker.internal:5534
  -> auto_road.public.goong_road
```

## Chay bang Docker

PostGIS cua `build-routing` phai dang chay va cong `5534` phai truy cap duoc:

```bash
docker ps --filter name=build_routing_postgis
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8081/health
```

Mo `http://127.0.0.1:8081`. Viewport mac dinh dat tai trung tam Ha Noi.

Docker Compose chi bind editor vao `127.0.0.1` de tranh mo quyen ghi database ra mang ngoai. Sao chep `.env.example` thanh `.env` khi can thay cong, database, tai khoan hoac bang du lieu.

## Du lieu va Save

Adapter cung cap cac endpoint iD can dung, gom `map.json`, way/node lookup, capabilities, user noi bo va changeset upload. Khi Save:

- thay doi geometry va tag cua line duoc ghi vao `public.goong_road` trong transaction;
- tag trung voi cot text duoc ghi vao cot tuong ung, tag khac duoc luu JSON trong cot `tags`;
- version va lich su upload duoc luu trong schema `goong_editor`;
- di chuyen mot node se cap nhat cac way dung chung toa do 7 chu so;
- them, xoa, tach va noi line duoc ho tro.

Bang nay chi chua road geometry, vi vay point co tag va relation se bi tu choi khi Save. Gioi han mac dinh la 5.000 way cho mot tile; co the doi bang `EDITOR_MAX_WAYS`.

## Kiem tra

```bash
npm ci
npm run test:server
npm run smoke:server
docker compose logs -f editor
```

Mot truy van bbox co the kiem tra adapter dang tra du lieu that:

```bash
curl 'http://127.0.0.1:8081/api/0.6/map.json?bbox=105.842,21.024,105.848,21.030'
```
