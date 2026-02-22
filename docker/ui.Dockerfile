FROM nginx:1.27-alpine

COPY docker/ui.conf /etc/nginx/conf.d/default.conf
COPY server/dashboard/public/ /usr/share/nginx/html/
