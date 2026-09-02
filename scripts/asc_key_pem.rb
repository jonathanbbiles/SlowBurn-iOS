# frozen_string_literal: true
#
# asc_key_pem.rb — turn whatever APP_STORE_CONNECT_PRIVATE_KEY holds into PEM text that
# Ruby's OpenSSL, and therefore fastlane, can actually read.
#
# WHY THIS EXISTS
# Codemagic injects the App Store Connect key as APP_STORE_CONNECT_PRIVATE_KEY, and its own
# `app-store-connect` CLI is lenient about the shape. fastlane is not: it takes a single
# boolean, `is_key_content_base64`, which cannot express "it might be any of these". So the
# CLI authenticates happily while fastlane fails, which looks exactly like a bad key and is
# not one. Shapes seen in practice:
#
#   1. PEM text                    -----BEGIN PRIVATE KEY----- … with real newlines
#   2. PEM with escaped newlines   the same, but "\n" as two literal characters
#   3. base64-encoded PEM          the whole .p8 file base64'd into one line
#   4. a path to the .p8 on disk   some setups write the key out and export where
#   5. a bare base64 key body      the .p8 with its BEGIN/END armor stripped
#   6. not in the variable at all  the .p8 written to ~/.appstoreconnect/private_keys/,
#                                  which is where Apple's tools look by convention. This is
#                                  the one that fooled us longest: Codemagic's CLI finds the
#                                  file on its own and authenticates, so the key looks fine
#                                  everywhere except fastlane, which was only ever handed
#                                  the environment variable.
#
# DON'T CLASSIFY — VERIFY.
# An earlier version of this file guessed the shape by looking for the "-----BEGIN" marker.
# That is exactly the bug it was written to fix: shape 5 has no marker, so a perfectly good
# key was reported as garbage. This version builds every candidate form and hands back the
# first one OpenSSL can actually parse as an EC private key. The test is the parse itself,
# so a sixth shape nobody has seen yet either works or fails honestly.
#
# ONE SOURCE OF TRUTH. The Fastfile requires this file, asc-auth-check.sh's probe requires
# it, and CI runs it directly:
#
#     ruby scripts/asc_key_pem.rb        exit 0 + print the SHAPE, never the key
#
# THE KEY IS NEVER PRINTED, never written to disk, and never passed on a command line —
# only its shape and length. Build logs are not private.
#
# No `require "base64"`: String#unpack1("m") is base64 decoding built into the language,
# with no gem behind it, and base64 stopped being a default gem in newer Rubies — exactly
# the kind of require that fails on a build image and nowhere else.

require "openssl"

# Where Apple's tooling keeps API keys by convention. codemagic-cli-tools reads these
# without being told, which is why `app-store-connect` can authenticate in a build where
# the environment variable holds nothing useful.
ASC_KEY_SEARCH_DIRS = [
  File.join(Dir.home.to_s, ".appstoreconnect", "private_keys"),
  File.join(Dir.home.to_s, "private_keys"),
  File.join(Dir.pwd, "private_keys")
].freeze

# .p8 files on disk, the one matching APP_STORE_CONNECT_KEY_IDENTIFIER first.
def asc_key_files(key_id = ENV["APP_STORE_CONNECT_KEY_IDENTIFIER"])
  files = ASC_KEY_SEARCH_DIRS.uniq.flat_map do |dir|
    Dir.exist?(dir) ? Dir.glob(File.join(dir, "*.p8")) : []
  end
  files.uniq.sort_by { |f| key_id.to_s.empty? || !File.basename(f).include?(key_id.to_s) ? 1 : 0 }
end

# Every form the value might be, cheapest first. Nothing here decides anything; the parse
# below does. Each entry is [candidate_pem, description].
def asc_key_candidates(raw)
  candidates = []
  trimmed = raw.strip.gsub(/\A["']|["']\z/, "") # some setups store the value quoted

  candidates << [raw, "PEM text"]
  candidates << [trimmed, "PEM text (quotes stripped)"]
  candidates << [raw.gsub('\n', "\n"), "PEM text with escaped newlines"]
  candidates << [trimmed.gsub('\n', "\n"), "PEM text with escaped newlines (quotes stripped)"]

  # A path to the .p8 rather than its contents.
  if trimmed.length < 4096 && !trimmed.include?("\n") && File.file?(trimmed)
    begin
      candidates << [File.read(trimmed), "the .p8 file at that path"]
    rescue StandardError # rubocop:disable Lint/SuppressedException
      # Unreadable. Other candidates may still work.
    end
  end

  # The whole PEM file, base64'd.
  begin
    # Left in whatever encoding the bytes are. Decoding arbitrary input yields binary, and
    # calling a text method such as strip on it raises "invalid byte sequence" — which is
    # how this file first crashed on a key it should simply have rejected.
    candidates << [trimmed.unpack1("m").to_s, "base64-encoded key (PEM or raw DER)"]
  rescue StandardError # rubocop:disable Lint/SuppressedException
  end

  # A bare base64 key body with the BEGIN/END armor stripped. Wrap it back up. Both armors
  # are tried because PKCS#8 (what Apple issues) and SEC1 are not interchangeable.
  body = trimmed.gsub(/\s+/, "")
  if body.length > 100 && body.match?(%r{\A[A-Za-z0-9+/=]+\z})
    wrapped = body.scan(/.{1,64}/).join("\n")
    candidates << ["-----BEGIN PRIVATE KEY-----\n#{wrapped}\n-----END PRIVATE KEY-----\n",
                   "bare base64 key body, PKCS#8 armor added"]
    candidates << ["-----BEGIN EC PRIVATE KEY-----\n#{wrapped}\n-----END EC PRIVATE KEY-----\n",
                   "bare base64 key body, SEC1 armor added"]
  end

  # Shape 6: the key is not in the variable at all, it is a file on disk.
  asc_key_files.each do |path|
    begin
      candidates << [File.read(path), "the .p8 found at #{path}"]
    rescue StandardError # rubocop:disable Lint/SuppressedException
      # Unreadable. Other candidates may still work.
    end
  end

  candidates
end

# Returns [pem_text, shape_description], or nil when nothing parses as a private key.
def asc_private_key_pem(raw = ENV["APP_STORE_CONNECT_PRIVATE_KEY"])
  # No early return on an empty variable: the key may still be on disk, and that is exactly
  # the case this function exists to survive.
  raw = raw.to_s

  asc_key_candidates(raw).each do |candidate, description|
    # `empty?` and `bytesize` are encoding-safe; `strip` is not, and a candidate may be
    # arbitrary bytes from a failed base64 decode.
    next if candidate.nil? || candidate.to_s.bytesize.zero?

    begin
      key = OpenSSL::PKey.read(candidate)
    rescue StandardError
      next
    end
    # Hand back the key re-serialised, not the bytes that came in: whatever the input was —
    # DER, armor-less base64, escaped newlines — fastlane then always receives real PEM text
    # and `is_key_content_base64: false` is always the right answer.
    pem = begin
      key.to_pem
    rescue StandardError
      candidate
    end

    # App Store Connect keys are always ES256, i.e. EC P-256. Anything else is the wrong key.
    return [pem, description] if key.is_a?(OpenSSL::PKey::EC)

    return [pem, "#{description} (WARNING: #{key.class}, not EC — is this an ASC key?)"]
  end

  nil
end

# Run directly: say what shape the key is in, without ever revealing it.
if $PROGRAM_NAME == __FILE__
  raw = ENV["APP_STORE_CONNECT_PRIVATE_KEY"].to_s
  puts "APP_STORE_CONNECT_PRIVATE_KEY: #{raw.length} characters"
  found = asc_key_files
  puts "key files on disk: #{found.empty? ? 'none' : found.join(', ')}"

  result = asc_private_key_pem(raw)
  if result.nil?
    puts "FATAL: none of the forms tried parse as a private key"
    puts "forms tried parse as a private key:"
    asc_key_candidates(raw).each { |_, description| puts "  - #{description}" }
    puts "and no readable .p8 in: #{ASC_KEY_SEARCH_DIRS.join(', ')}"
    puts "Re-add it in Codemagic by pasting the .p8 file contents verbatim, BEGIN/END included."
    exit 1
  end

  pem, shape = result
  puts "key shape:  #{shape}"
  puts "PEM lines:  #{pem.lines.count}   (a .p8 has about 5)"
  puts "parsed:     #{OpenSSL::PKey.read(pem).class} — fastlane can read this"
  exit 0
end
