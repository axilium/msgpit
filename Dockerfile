FROM php:8.3-cli-alpine

# Set by the release workflow from the git tag; "dev" in a local build.
ARG MSGPIT_VERSION=dev

LABEL org.opencontainers.image.title="msgpit" \
      org.opencontainers.image.description="Local catcher for outgoing SMS and push messages. Mailpit, but for message provider APIs." \
      org.opencontainers.image.source="https://github.com/raymondsteffann/msgpit" \
      org.opencontainers.image.documentation="https://github.com/raymondsteffann/msgpit#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${MSGPIT_VERSION}"

WORKDIR /app

# su-exec is how the entrypoint drops privileges; ~20kB and the only package we add.
RUN apk add --no-cache su-exec

# The source is mounted over /app during development, so a stale opcache entry is pure confusion.
RUN printf 'opcache.revalidate_freq=0\n' > /usr/local/etc/php/conf.d/msgpit.ini

# No vendor/ at runtime: index.php registers its own autoloader. docs/ ships too, because the
# UI serves the reference pages from it.
COPY providers.php ./
COPY src/ ./src/
COPY public/ ./public/
COPY docs/ ./docs/

COPY docker-entrypoint.sh /usr/local/bin/

RUN mkdir -p /data \
    && chown -R www-data:www-data /data

ENV MSGPIT_DB=/data/msgpit.sqlite \
    MSGPIT_VERSION=${MSGPIT_VERSION} \
    PHP_CLI_SERVER_WORKERS=16

VOLUME /data
EXPOSE 8080

# Starts as root so the entrypoint can fix /data, then runs the server as www-data.
ENTRYPOINT ["docker-entrypoint.sh"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD php -r 'exit(@file_get_contents("http://127.0.0.1:8080/healthz") === false ? 1 : 0);'

CMD ["php", "-S", "0.0.0.0:8080", "-t", "public", "public/index.php"]
