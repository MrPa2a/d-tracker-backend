ALTER TABLE item_effects 
ADD CONSTRAINT fk_effect_icons 
FOREIGN KEY (effect_id) 
REFERENCES effect_icons (effect_id);
