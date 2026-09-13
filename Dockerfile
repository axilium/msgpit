FROM php:8.3-cli-alpine

WORKDIR /app

# The source is mounted over /app during development; this copy is what the
# published image ships. No vendor/ at runtime: index.php autoloads src/.
COPY providers.php ./
COPY src/ ./src/
COPY public/ ./public/

RUN mkdir -p /data

# The source is mounted over /app during development, so stale opcache entries are pure confusion.
RUN echo "opcache.revalidate_freq=0" > /usr/local/etc/php/conf.d/msgpit.ini

ENV MSGPIT_DB=/data/msgpit.sqlite \
    PHP_CLI_SERVER_WORKERS=16

EXPOSE 8080

CMD ["php", "-S", "0.0.0.0:8080", "-t", "public", "public/index.php"]
