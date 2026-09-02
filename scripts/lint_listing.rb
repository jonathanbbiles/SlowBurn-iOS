#!/usr/bin/env ruby
# frozen_string_literal: true
#
# lint_listing.rb — check an App Store listing in fastlane/ against Apple's limits.
#
# Plain Ruby, no fastlane, no network, no gems. That is deliberate:
#
#   * it can be run and tested on a laptop, where fastlane is not installed;
#   * it has no working-directory surprises. fastlane runs lanes with the working
#     directory set to ./fastlane, so a path like "./fastlane/metadata" written inside a
#     Fastfile resolves to fastlane/fastlane/metadata and silently finds nothing. This
#     script anchors on its own location instead;
#   * it catches the mistakes that cost a whole review cycle BEFORE anything touches the
#     network, so a bad listing never becomes a rejection.
#
# USAGE
#     ruby scripts/lint_listing.rb [repo-root]
#     ASC_METADATA_PATH=… ASC_SCREENSHOTS_PATH=… ruby scripts/lint_listing.rb
#
# Exit 0 when the listing is clean, 1 when Apple would reject it. Warnings never fail.

# Character limits Apple enforces at submission time.
FIELD_LIMITS = {
  "name.txt" => 30,
  "subtitle.txt" => 30,
  "keywords.txt" => 100,
  "promotional_text.txt" => 170,
  "description.txt" => 4000,
  "release_notes.txt" => 4000
}.freeze

REQUIRED_LOCALE_FILES = %w[name.txt description.txt keywords.txt support_url.txt privacy_url.txt].freeze
REQUIRED_REVIEW_FILES = %w[first_name.txt last_name.txt email_address.txt phone_number.txt].freeze

# Pixel sizes App Store Connect accepts, by display slot. deliver picks a screenshot's slot
# from its PIXEL SIZE, not its filename — a file of the wrong size is silently dropped, and
# the slot it should have filled is empty at review time, which is a 2.3.3 rejection.
# Unknown sizes warn rather than fail: this table will age, and Apple is the authority.
SCREENSHOT_SIZES = {
  [1320, 2868] => 'iPhone 6.9"', [2868, 1320] => 'iPhone 6.9" (landscape)',
  [1290, 2796] => 'iPhone 6.9"/6.7"', [2796, 1290] => 'iPhone 6.9"/6.7" (landscape)',
  [1284, 2778] => 'iPhone 6.5"/6.7"', [2778, 1284] => 'iPhone 6.5"/6.7" (landscape)',
  [1242, 2688] => 'iPhone 6.5"', [2688, 1242] => 'iPhone 6.5" (landscape)',
  [1242, 2208] => 'iPhone 5.5"', [2208, 1242] => 'iPhone 5.5" (landscape)',
  [2064, 2752] => 'iPad 13"', [2752, 2064] => 'iPad 13" (landscape)',
  [2048, 2732] => 'iPad 12.9"/13"', [2732, 2048] => 'iPad 12.9"/13" (landscape)',
  [1668, 2388] => 'iPad 11"', [2388, 1668] => 'iPad 11" (landscape)'
}.freeze

@errors = []
@warnings = []

def fail!(message)
  @errors << message
end

def warn!(message)
  @warnings << message
end

def info(message)
  puts "       #{message}"
end

# Width and height straight out of the PNG IHDR chunk: bytes 16..23 of the file. Two
# integers at a fixed offset, so there is no reason to put an image gem on a build machine.
def png_dimensions(path)
  header = File.binread(path, 24)
  return nil if header.nil? || header.bytesize < 24
  return nil unless header[0, 8] == "\x89PNG\r\n\x1A\n".b

  header[16, 8].unpack("N2")
rescue StandardError
  nil
end

# Resolve a directory that may be given by env, or sit under the repo root, or — when this
# is somehow run from inside fastlane/ — one level up.
def resolve_dir(env_name, root, *relative_candidates)
  from_env = ENV[env_name].to_s.strip
  return File.expand_path(from_env) unless from_env.empty?

  relative_candidates.each do |candidate|
    path = File.expand_path(candidate, root)
    return path if Dir.exist?(path)
  end
  File.expand_path(relative_candidates.first, root)
end

def check_locale(locale_dir)
  locale = File.basename(locale_dir)

  REQUIRED_LOCALE_FILES.each do |basename|
    path = File.join(locale_dir, basename)
    if !File.exist?(path)
      fail!("#{locale}: missing #{basename}")
    elsif File.read(path).strip.empty?
      fail!("#{locale}: #{basename} is empty")
    end
  end

  FIELD_LIMITS.each do |basename, limit|
    path = File.join(locale_dir, basename)
    next unless File.exist?(path)

    # Apple counts characters, not bytes, and ignores the trailing newline an editor leaves
    # behind. An em dash is one character here and three bytes on disk.
    length = File.read(path, encoding: "UTF-8").strip.length
    if length > limit
      fail!("#{locale}: #{basename} is #{length} characters, Apple's limit is #{limit}")
    else
      info("#{locale}/#{basename}: #{length}/#{limit} characters")
    end
  end

  keywords = File.join(locale_dir, "keywords.txt")
  if File.exist?(keywords) && File.read(keywords).include?(", ")
    warn!("#{locale}: keywords.txt has ', ' — every space costs one of the 100 characters")
  end
end

def check_review_information(metadata_dir)
  review_dir = File.join(metadata_dir, "review_information")
  unless Dir.exist?(review_dir)
    warn!("no review_information/ — the reviewer contact will be whatever App Store Connect already has")
    return
  end

  REQUIRED_REVIEW_FILES.each do |basename|
    path = File.join(review_dir, basename)
    fail!("review_information/#{basename} is missing or empty") if !File.exist?(path) || File.read(path).strip.empty?
  end

  notes = File.join(review_dir, "notes.txt")
  if !File.exist?(notes) || File.read(notes).strip.empty?
    warn!("review_information/notes.txt is empty — reviewer notes are how you pre-empt a rejection")
  end
end

def check_screenshots(screenshots_dir)
  unless Dir.exist?(screenshots_dir)
    fail!("no screenshots directory at #{screenshots_dir}")
    return
  end

  shots = Dir.glob(File.join(screenshots_dir, "**", "*.{png,PNG,jpg,jpeg,JPG,JPEG}")).sort
  if shots.empty?
    fail!("no screenshots under #{screenshots_dir}")
    return
  end

  by_slot = Hash.new(0)
  shots.each do |shot|
    name = File.basename(shot)
    if File.extname(shot).downcase != ".png"
      warn!("#{name} is not a PNG")
      next
    end

    dimensions = png_dimensions(shot)
    if dimensions.nil?
      warn!("#{name} could not be read as a PNG")
      next
    end

    slot = SCREENSHOT_SIZES[dimensions]
    if slot.nil?
      warn!("#{name} is #{dimensions[0]}x#{dimensions[1]}, which matches no App Store slot — " \
            "Apple will ignore or reject it")
    else
      by_slot[slot] += 1
    end

    warn!("#{name} has no NN- order prefix — deliver orders screenshots by it") unless name =~ /\A\d{2}[-_]|[-_]\d{2}[-_]/
  end

  by_slot.sort.each { |slot, count| info("#{count} screenshot(s) -> #{slot}") }
end

# ── main ───────────────────────────────────────────────────────────────────────────────
root = ARGV[0] || File.expand_path("..", __dir__)
metadata_dir = resolve_dir("ASC_METADATA_PATH", root, "fastlane/metadata", "metadata")
screenshots_dir = resolve_dir("ASC_SCREENSHOTS_PATH", root, "fastlane/screenshots", "screenshots")

puts "== App Store listing lint (local files only — no network)"
info("repo root:   #{root}")
info("metadata:    #{metadata_dir}")
info("screenshots: #{screenshots_dir}")

if Dir.exist?(metadata_dir)
  locales = Dir.glob(File.join(metadata_dir, "*")).select do |path|
    File.directory?(path) && File.basename(path) =~ /\A[a-z]{2}(-[A-Za-z]{2,4})?\z/
  end

  if locales.empty?
    fail!("no locale directory (expected e.g. #{metadata_dir}/en-US/)")
  else
    locales.sort.each { |locale_dir| check_locale(locale_dir) }
  end

  check_review_information(metadata_dir)
else
  fail!("no metadata directory at #{metadata_dir}")
end

check_screenshots(screenshots_dir)

@warnings.each { |w| puts "  WARN  #{w}" }
@errors.each { |e| puts "  FAIL  #{e}" }

puts
if @errors.empty?
  puts "  LISTING OK — #{@warnings.count} warning(s), 0 problems."
  exit 0
end

puts "  LISTING NOT SUBMITTABLE — #{@errors.count} problem(s) above."
puts "  Fix them in fastlane/ and push again. Nothing was sent to Apple."
exit 1
